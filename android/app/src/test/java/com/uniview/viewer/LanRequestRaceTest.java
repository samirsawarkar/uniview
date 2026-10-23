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
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class LanRequestRaceTest {
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

    private ServerSocket createServer() throws IOException {
        ServerSocket serverSocket = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        Thread serverThread = new Thread(() -> {
            try (Socket socket = serverSocket.accept()) {
                InputStream in = socket.getInputStream();
                StringBuilder sb = new StringBuilder();
                byte[] buf = new byte[1024];
                int read;
                while ((read = in.read(buf)) != -1) {
                    sb.append(new String(buf, 0, read, StandardCharsets.US_ASCII));
                    if (sb.toString().contains("\r\n\r\n")) {
                        break;
                    }
                }
                OutputStream out = socket.getOutputStream();
                byte[] resp = "OK".getBytes(StandardCharsets.UTF_8);
                String header = "HTTP/1.1 200 OK\r\n"
                        + "Content-Length: " + resp.length + "\r\n"
                        + "Content-Type: text/plain\r\n"
                        + "Connection: close\r\n\r\n";
                out.write(header.getBytes(StandardCharsets.US_ASCII));
                out.write(resp);
                out.flush();
            } catch (IOException ignored) {
            }
        });
        serverThread.setDaemon(true);
        serverThread.start();
        return serverSocket;
    }

    @Test(timeout = 10000)
    public void testDeadlineWinsRaceWhenDeadlineFiresAfterBodyRead() throws Exception {
        // Catches mutation: replacing CAS with old flags where fully read response always succeeds even if deadline fired.
        try (ServerSocket server = createServer()) {
            String url = "http://127.0.0.1:" + server.getLocalPort() + "/v1/rpc";
            CountDownLatch timeoutCasDoneLatch = new CountDownLatch(1);
            CountDownLatch bodyReadReachedLatch = new CountDownLatch(1);

            LanRequest.Hooks hooks = new LanRequest.Hooks() {
                @Override
                void afterBodyRead() {
                    bodyReadReachedLatch.countDown();
                    try {
                        timeoutCasDoneLatch.await(5, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }

                @Override
                void beforeTimeoutCas() {
                    try {
                        bodyReadReachedLatch.await(5, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }

                @Override
                void afterTimeoutCas(int stateAfterCas) {
                    timeoutCasDoneLatch.countDown();
                }
            };

            long deadlineAtNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(100);
            try {
                LanRequest.execute(
                        url,
                        new byte[0],
                        "text/plain",
                        2000,
                        2000,
                        deadlineAtNanos,
                        65536,
                        scheduler,
                        hooks
                );
                fail("Expected LanTimeoutException when deadline task wins the CAS race");
            } catch (LanTimeoutException expected) {
                assertEquals("The computer did not answer in time.", expected.getMessage());
            }
        }
    }

    @Test(timeout = 10000)
    public void testCompletionWinsRaceWhenResponseCompletedBeforeTimeoutCas() throws Exception {
        // Catches mutation: deadline task overwriting COMPLETED state or disconnecting connection after completion returned.
        try (ServerSocket server = createServer()) {
            String url = "http://127.0.0.1:" + server.getLocalPort() + "/v1/rpc";
            CountDownLatch timeoutStartedLatch = new CountDownLatch(1);
            CountDownLatch executeReturnedLatch = new CountDownLatch(1);
            CountDownLatch timeoutFinishedLatch = new CountDownLatch(1);
            AtomicInteger observedStateInTimeout = new AtomicInteger(-1);

            LanRequest.Hooks hooks = new LanRequest.Hooks() {
                @Override
                void afterBodyRead() {
                    try {
                        timeoutStartedLatch.await(5, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }

                @Override
                void beforeTimeoutCas() {
                    timeoutStartedLatch.countDown();
                    try {
                        executeReturnedLatch.await(5, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }

                @Override
                void afterTimeoutCas(int stateAfterCas) {
                    observedStateInTimeout.set(stateAfterCas);
                    timeoutFinishedLatch.countDown();
                }
            };

            long deadlineAtNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(100);
            LanRequest.Result result = LanRequest.execute(
                    url,
                    new byte[0],
                    "text/plain",
                    2000,
                    2000,
                    deadlineAtNanos,
                    65536,
                    scheduler,
                    hooks
            );

            executeReturnedLatch.countDown();
            assertTrue(timeoutFinishedLatch.await(5, TimeUnit.SECONDS));

            assertEquals(200, result.status);
            assertArrayEquals("OK".getBytes(StandardCharsets.UTF_8), result.body);
            assertEquals(LanRequest.COMPLETED, observedStateInTimeout.get());
        }
    }
}
