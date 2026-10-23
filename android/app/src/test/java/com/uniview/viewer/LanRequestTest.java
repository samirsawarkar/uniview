package com.uniview.viewer;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Tests for LanRequest native HTTP POST client.
 *
 * Race condition resolution:
 * Documented outcome: a response that was fully read is returned.
 * Even if the deadline task executes while completion flags are being set,
 * a fully read response takes precedence and is returned, while the connection
 * is closed and the deadline task is cancelled. If the deadline task fires while
 * reading is still blocked, LanTimeoutException is thrown.
 */
public class LanRequestTest {
    private ScheduledExecutorService scheduler;

    @Before
    public void setUp() {
        scheduler = Executors.newScheduledThreadPool(4);
    }

    @After
    public void tearDown() {
        if (scheduler != null) {
            scheduler.shutdownNow();
        }
    }

    @Test(timeout = 10000)
    public void testNormalResponse() throws Exception {
        ServerSocket server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        int port = server.getLocalPort();
        byte[] expectedBody = "hello from local server".getBytes(StandardCharsets.UTF_8);

        Thread serverThread = new Thread(() -> {
            try (Socket socket = server.accept();
                 InputStream is = socket.getInputStream();
                 OutputStream os = socket.getOutputStream()) {
                byte[] buf = new byte[1024];
                is.read(buf);

                String response = "HTTP/1.1 200 OK\r\n"
                        + "Content-Type: text/plain\r\n"
                        + "Content-Length: " + expectedBody.length + "\r\n"
                        + "Connection: close\r\n\r\n";
                os.write(response.getBytes(StandardCharsets.UTF_8));
                os.write(expectedBody);
                os.flush();
            } catch (IOException ignored) {
            }
        });
        serverThread.start();

        try {
            long deadlineAtNanos = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
            LanRequest.Result result = LanRequest.execute(
                    "http://127.0.0.1:" + port + "/v1/rpc",
                    new byte[0],
                    "text/plain",
                    2000,
                    2000,
                    deadlineAtNanos,
                    64 * 1024,
                    scheduler
            );

            assertEquals(200, result.status);
            assertArrayEquals(expectedBody, result.body);
        } finally {
            server.close();
            serverThread.join(1000);
        }
    }

    @Test(timeout = 10000)
    public void testStalledServerTimesOutWithinDeadlinePlusOneSecond() throws Exception {
        ServerSocket server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        int port = server.getLocalPort();
        CountDownLatch connected = new CountDownLatch(1);

        Thread serverThread = new Thread(() -> {
            try (Socket socket = server.accept()) {
                connected.countDown();
                Thread.sleep(5000);
            } catch (Exception ignored) {
            }
        });
        serverThread.start();

        try {
            long startNanos = System.nanoTime();
            long deadlineAtNanos = startNanos + TimeUnit.MILLISECONDS.toNanos(300);

            try {
                LanRequest.execute(
                        "http://127.0.0.1:" + port + "/v1/rpc",
                        new byte[0],
                        null,
                        2000,
                        10000,
                        deadlineAtNanos,
                        64 * 1024,
                        scheduler
                );
                fail("Expected LanTimeoutException");
            } catch (LanTimeoutException e) {
                long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startNanos);
                assertTrue("Should time out within deadline + 1s (elapsed: " + elapsedMs + "ms)", elapsedMs <= 1300);
                assertEquals("The computer did not answer in time.", e.getMessage());
            }
        } finally {
            server.close();
            serverThread.join(1000);
        }
    }

    @Test(timeout = 10000)
    public void testTricklingServerTimesOutWithinDeadlinePlusOneSecond() throws Exception {
        ServerSocket server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        int port = server.getLocalPort();
        AtomicBoolean stopServer = new AtomicBoolean(false);

        Thread serverThread = new Thread(() -> {
            try (Socket socket = server.accept();
                 InputStream is = socket.getInputStream();
                 OutputStream os = socket.getOutputStream()) {
                byte[] buf = new byte[1024];
                is.read(buf);

                String response = "HTTP/1.1 200 OK\r\n"
                        + "Content-Type: application/octet-stream\r\n"
                        + "Connection: close\r\n\r\n";
                os.write(response.getBytes(StandardCharsets.UTF_8));
                os.flush();

                while (!stopServer.get()) {
                    Thread.sleep(100);
                    os.write(0x2a);
                    os.flush();
                }
            } catch (Exception ignored) {
            }
        });
        serverThread.start();

        try {
            long startNanos = System.nanoTime();
            long deadlineAtNanos = startNanos + TimeUnit.MILLISECONDS.toNanos(700);

            try {
                LanRequest.execute(
                        "http://127.0.0.1:" + port + "/v1/rpc",
                        new byte[0],
                        null,
                        2000,
                        1000,
                        deadlineAtNanos,
                        64 * 1024,
                        scheduler
                );
                fail("Expected LanTimeoutException");
            } catch (LanTimeoutException e) {
                long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startNanos);
                assertTrue("Should time out within deadline + 1s (elapsed: " + elapsedMs + "ms)", elapsedMs <= 1700);
                assertEquals("The computer did not answer in time.", e.getMessage());
            }
        } finally {
            stopServer.set(true);
            server.close();
            serverThread.join(1000);
        }
    }

    @Test(timeout = 10000)
    public void testOversizeResponseThrowsIoException() throws Exception {
        ServerSocket server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        int port = server.getLocalPort();
        int twoMiB = 2 * 1024 * 1024;

        Thread serverThread = new Thread(() -> {
            try (Socket socket = server.accept();
                 InputStream is = socket.getInputStream();
                 OutputStream os = socket.getOutputStream()) {
                byte[] buf = new byte[1024];
                is.read(buf);

                String response = "HTTP/1.1 200 OK\r\n"
                        + "Content-Type: application/octet-stream\r\n"
                        + "Content-Length: " + twoMiB + "\r\n"
                        + "Connection: close\r\n\r\n";
                os.write(response.getBytes(StandardCharsets.UTF_8));
                os.flush();

                byte[] chunk = new byte[16 * 1024];
                int sent = 0;
                while (sent < twoMiB) {
                    int toWrite = Math.min(chunk.length, twoMiB - sent);
                    os.write(chunk, 0, toWrite);
                    sent += toWrite;
                }
                os.flush();
            } catch (Exception ignored) {
            }
        });
        serverThread.start();

        try {
            long deadlineAtNanos = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
            LanRequest.execute(
                    "http://127.0.0.1:" + port + "/v1/rpc",
                    new byte[0],
                    null,
                    2000,
                    2000,
                    deadlineAtNanos,
                    64 * 1024,
                    scheduler
            );
            fail("Expected IOException for oversize body");
        } catch (IOException e) {
            assertTrue("Expected 'response too large' message but got: " + e.getMessage(),
                    e.getMessage() != null && e.getMessage().contains("response too large"));
        } finally {
            server.close();
            serverThread.join(1000);
        }
    }

    @Test(timeout = 10000)
    public void testAlreadyExpiredThrowsImmediatelyWithoutConnecting() throws Exception {
        ServerSocket server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        int port = server.getLocalPort();
        AtomicBoolean connectionReceived = new AtomicBoolean(false);

        Thread serverThread = new Thread(() -> {
            try (Socket socket = server.accept()) {
                connectionReceived.set(true);
            } catch (Exception ignored) {
            }
        });
        serverThread.start();

        try {
            long deadlineAtNanos = System.nanoTime() - TimeUnit.MILLISECONDS.toNanos(100);

            try {
                LanRequest.execute(
                        "http://127.0.0.1:" + port + "/v1/rpc",
                        new byte[0],
                        null,
                        2000,
                        2000,
                        deadlineAtNanos,
                        64 * 1024,
                        scheduler
                );
                fail("Expected LanTimeoutException");
            } catch (LanTimeoutException e) {
                assertEquals("The computer did not answer in time.", e.getMessage());
            }

            Thread.sleep(100);
            assertFalse("Server should never receive a connection", connectionReceived.get());
        } finally {
            server.close();
            serverThread.join(1000);
        }
    }
}
