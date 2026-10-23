package com.uniview.viewer;

import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class LanDispatcherDefaultTest {
    @Test(timeout = 10000)
    public void testProductionQueueBoundsAndRejection() throws Exception {
        // Catches mutation: making the production queue in createDefault() unbounded (e.g. LinkedBlockingQueue) or sized differently.
        CountDownLatch blockLatch = new CountDownLatch(1);
        CountDownLatch runningStartedLatch = new CountDownLatch(64);
        AtomicInteger earlyFails = new AtomicInteger(0);

        LanDispatcher.RequestRunner blockingRunner = (url, body, contentType, connectTimeoutMs, readTimeoutMs, deadlineAtNanos, maxResponseBytes, scheduler) -> {
            runningStartedLatch.countDown();
            try {
                blockLatch.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return new LanRequest.Result(200, new byte[0]);
        };

        LanDispatcher dispatcher = LanDispatcher.createDefault(blockingRunner);
        try {
            assertEquals(64, dispatcher.poolSize());
            assertEquals(256, dispatcher.queueCapacity());

            LanDispatcher.Request req = new LanDispatcher.Request(
                    "http://127.0.0.1:8080/test",
                    new byte[0],
                    "text/plain",
                    1000,
                    1000,
                    65536
            );

            // Submit 64 running tasks
            for (int i = 0; i < 64; i++) {
                dispatcher.submit(req, 60000, new LanDispatcher.Callback() {
                    @Override
                    public void ok(LanRequest.Result r) {
                    }

                    @Override
                    public void fail(String message) {
                        earlyFails.incrementAndGet();
                    }
                });
            }

            // Wait for all 64 running tasks to occupy the pool threads
            assertTrue("Expected 64 worker threads to start running", runningStartedLatch.await(5, TimeUnit.SECONDS));

            // Submit 256 queued tasks
            for (int i = 0; i < 256; i++) {
                dispatcher.submit(req, 60000, new LanDispatcher.Callback() {
                    @Override
                    public void ok(LanRequest.Result r) {
                    }

                    @Override
                    public void fail(String message) {
                        earlyFails.incrementAndGet();
                    }
                });
            }

            assertEquals(0, earlyFails.get());

            // The 321st submission must get exactly one fail("Too many requests to the computer.")
            AtomicInteger failCount321 = new AtomicInteger(0);
            AtomicReference<String> failMessage321 = new AtomicReference<>();
            dispatcher.submit(req, 60000, new LanDispatcher.Callback() {
                @Override
                public void ok(LanRequest.Result r) {
                }

                @Override
                public void fail(String message) {
                    failCount321.incrementAndGet();
                    failMessage321.set(message);
                }
            });

            assertEquals(1, failCount321.get());
            assertEquals("Too many requests to the computer.", failMessage321.get());
        } finally {
            blockLatch.countDown();
            dispatcher.shutdown();
        }
    }
}
