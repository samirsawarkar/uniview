package com.uniview.viewer;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class LanDispatcherTest {
    private ScheduledExecutorService scheduler;

    @Before
    public void setUp() {
        scheduler = Executors.newScheduledThreadPool(1);
    }

    @After
    public void tearDown() {
        if (scheduler != null) {
            scheduler.shutdownNow();
        }
    }

    @Test(timeout = 10000)
    public void testSaturationRejectsWithProperMessageAndCompletesPriorRequests() throws Exception {
        // Mutation caught: if queue saturation does not reject with "Too many requests to the computer.",
        // if queue capacity is unbounded, or if any callback is fired more than once, this test fails.
        ThreadPoolExecutor executor = new ThreadPoolExecutor(
                1,
                1,
                0L,
                TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(1)
        );

        CountDownLatch workerStartedLatch = new CountDownLatch(1);
        CountDownLatch unblockWorkerLatch = new CountDownLatch(1);

        LanDispatcher.RequestRunner runner = (url, body, ct, ctMs, rtMs, deadline, maxBytes, sched) -> {
            if ("http://127.0.0.1/req1".equals(url)) {
                workerStartedLatch.countDown();
                try {
                    unblockWorkerLatch.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            return new LanRequest.Result(200, new byte[0]);
        };

        LanDispatcher dispatcher = new LanDispatcher(executor, scheduler, System::nanoTime, runner);

        AtomicInteger cb1Ok = new AtomicInteger(0);
        AtomicInteger cb1Fail = new AtomicInteger(0);
        CountDownLatch cb1Latch = new CountDownLatch(1);
        LanDispatcher.Callback cb1 = new LanDispatcher.Callback() {
            @Override
            public void ok(LanRequest.Result r) {
                cb1Ok.incrementAndGet();
                cb1Latch.countDown();
            }

            @Override
            public void fail(String message) {
                cb1Fail.incrementAndGet();
                cb1Latch.countDown();
            }
        };

        AtomicInteger cb2Ok = new AtomicInteger(0);
        AtomicInteger cb2Fail = new AtomicInteger(0);
        CountDownLatch cb2Latch = new CountDownLatch(1);
        LanDispatcher.Callback cb2 = new LanDispatcher.Callback() {
            @Override
            public void ok(LanRequest.Result r) {
                cb2Ok.incrementAndGet();
                cb2Latch.countDown();
            }

            @Override
            public void fail(String message) {
                cb2Fail.incrementAndGet();
                cb2Latch.countDown();
            }
        };

        AtomicInteger cb3Ok = new AtomicInteger(0);
        AtomicInteger cb3Fail = new AtomicInteger(0);
        AtomicReference<String> cb3FailMsg = new AtomicReference<>();
        CountDownLatch cb3Latch = new CountDownLatch(1);
        LanDispatcher.Callback cb3 = new LanDispatcher.Callback() {
            @Override
            public void ok(LanRequest.Result r) {
                cb3Ok.incrementAndGet();
                cb3Latch.countDown();
            }

            @Override
            public void fail(String message) {
                cb3Fail.incrementAndGet();
                cb3FailMsg.set(message);
                cb3Latch.countDown();
            }
        };

        LanDispatcher.Request req1 = new LanDispatcher.Request("http://127.0.0.1/req1", null, null, 1000, 1000, 1024);
        LanDispatcher.Request req2 = new LanDispatcher.Request("http://127.0.0.1/req2", null, null, 1000, 1000, 1024);
        LanDispatcher.Request req3 = new LanDispatcher.Request("http://127.0.0.1/req3", null, null, 1000, 1000, 1024);

        try {
            dispatcher.submit(req1, 30000, cb1);
            assertTrue("Worker should have started request 1", workerStartedLatch.await(5, TimeUnit.SECONDS));

            dispatcher.submit(req2, 30000, cb2);
            dispatcher.submit(req3, 30000, cb3);

            assertTrue("Rejected request 3 must notify callback immediately", cb3Latch.await(5, TimeUnit.SECONDS));
            assertEquals(1, cb3Fail.get());
            assertEquals(0, cb3Ok.get());
            assertEquals("Too many requests to the computer.", cb3FailMsg.get());

            unblockWorkerLatch.countDown();

            assertTrue("Request 1 must complete", cb1Latch.await(5, TimeUnit.SECONDS));
            assertTrue("Request 2 must complete", cb2Latch.await(5, TimeUnit.SECONDS));

            assertEquals(1, cb1Ok.get());
            assertEquals(0, cb1Fail.get());
            assertEquals(1, cb2Ok.get());
            assertEquals(0, cb2Fail.get());
        } finally {
            unblockWorkerLatch.countDown();
            executor.shutdownNow();
        }
    }

    @Test(timeout = 10000)
    public void testQueuedExpiryFailsWithoutCallingRunner() throws Exception {
        // Mutation caught: if queue expiry is not checked before invoking the runner, or if deadline
        // is recalculated at dequeue time, the runner will be erroneously called and this test fails.
        ThreadPoolExecutor executor = new ThreadPoolExecutor(
                1,
                1,
                0L,
                TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(10)
        );

        CountDownLatch workerStarted = new CountDownLatch(1);
        CountDownLatch unblockWorker = new CountDownLatch(1);
        AtomicInteger runnerCalls = new AtomicInteger(0);

        LanDispatcher.RequestRunner runner = (url, body, ct, ctMs, rtMs, deadline, maxBytes, sched) -> {
            if ("http://127.0.0.1/blocker".equals(url)) {
                workerStarted.countDown();
                try {
                    unblockWorker.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                return new LanRequest.Result(200, new byte[0]);
            }
            runnerCalls.incrementAndGet();
            return new LanRequest.Result(200, new byte[0]);
        };

        AtomicLong fakeClockNanos = new AtomicLong(1_000_000_000L);
        LanDispatcher dispatcher = new LanDispatcher(executor, scheduler, fakeClockNanos::get, runner);

        CountDownLatch blockerLatch = new CountDownLatch(1);
        dispatcher.submit(
                new LanDispatcher.Request("http://127.0.0.1/blocker", null, null, 1000, 1000, 1024),
                60000,
                new LanDispatcher.Callback() {
                    @Override
                    public void ok(LanRequest.Result r) {
                        blockerLatch.countDown();
                    }

                    @Override
                    public void fail(String message) {
                        blockerLatch.countDown();
                    }
                }
        );

        assertTrue("Blocker request must occupy worker", workerStarted.await(5, TimeUnit.SECONDS));

        AtomicReference<String> failMsg = new AtomicReference<>();
        CountDownLatch queuedLatch = new CountDownLatch(1);
        dispatcher.submit(
                new LanDispatcher.Request("http://127.0.0.1/queued", null, null, 1000, 1000, 1024),
                100,
                new LanDispatcher.Callback() {
                    @Override
                    public void ok(LanRequest.Result r) {
                        queuedLatch.countDown();
                    }

                    @Override
                    public void fail(String message) {
                        failMsg.set(message);
                        queuedLatch.countDown();
                    }
                }
        );

        fakeClockNanos.addAndGet(TimeUnit.MILLISECONDS.toNanos(200));

        unblockWorker.countDown();

        assertTrue("Queued request callback must fire", queuedLatch.await(5, TimeUnit.SECONDS));
        assertTrue("Blocker request callback must fire", blockerLatch.await(5, TimeUnit.SECONDS));

        assertEquals("The computer did not answer in time.", failMsg.get());
        assertEquals("Counting RequestRunner must never be called for expired queued request", 0, runnerCalls.get());

        executor.shutdownNow();
    }

    @Test(timeout = 10000)
    public void testDeadlineCapturedAtSubmitPassedToRunner() throws Exception {
        // Mutation caught: if deadline is computed inside worker at dequeue time instead of submit time,
        // the received deadline will equal dequeueTime + 100ms instead of submitTime + 100ms.
        ThreadPoolExecutor executor = new ThreadPoolExecutor(
                1,
                1,
                0L,
                TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(10)
        );

        CountDownLatch workerStarted = new CountDownLatch(1);
        CountDownLatch unblockWorker = new CountDownLatch(1);
        AtomicLong receivedDeadline = new AtomicLong(0);
        CountDownLatch runnerExecuted = new CountDownLatch(1);

        LanDispatcher.RequestRunner runner = (url, body, ct, ctMs, rtMs, deadline, maxBytes, sched) -> {
            if ("http://127.0.0.1/blocker".equals(url)) {
                workerStarted.countDown();
                try {
                    unblockWorker.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                return new LanRequest.Result(200, new byte[0]);
            }
            receivedDeadline.set(deadline);
            runnerExecuted.countDown();
            return new LanRequest.Result(200, new byte[0]);
        };

        long submitTimeNanos = 2_000_000_000L;
        AtomicLong fakeClockNanos = new AtomicLong(submitTimeNanos);
        LanDispatcher dispatcher = new LanDispatcher(executor, scheduler, fakeClockNanos::get, runner);

        dispatcher.submit(
                new LanDispatcher.Request("http://127.0.0.1/blocker", null, null, 1000, 1000, 1024),
                60000,
                new LanDispatcher.Callback() {
                    @Override
                    public void ok(LanRequest.Result r) {}

                    @Override
                    public void fail(String message) {}
                }
        );

        assertTrue("Blocker must occupy worker", workerStarted.await(5, TimeUnit.SECONDS));

        dispatcher.submit(
                new LanDispatcher.Request("http://127.0.0.1/target", null, null, 1000, 1000, 1024),
                100,
                new LanDispatcher.Callback() {
                    @Override
                    public void ok(LanRequest.Result r) {}

                    @Override
                    public void fail(String message) {}
                }
        );

        fakeClockNanos.addAndGet(TimeUnit.MILLISECONDS.toNanos(50));

        unblockWorker.countDown();

        assertTrue("Runner must execute for target request", runnerExecuted.await(5, TimeUnit.SECONDS));
        long expectedDeadline = submitTimeNanos + TimeUnit.MILLISECONDS.toNanos(100);
        assertEquals("Runner must receive deadline computed at submit time", expectedDeadline, receivedDeadline.get());

        executor.shutdownNow();
    }

    @Test(timeout = 10000)
    public void testExactlyOnceCallbackDelivery() throws Exception {
        // Mutation caught: if exceptions from runner do not trigger cb.fail exactly once,
        // or if successful responses trigger callbacks multiple times, this test fails.
        ThreadPoolExecutor executor = new ThreadPoolExecutor(
                2,
                2,
                0L,
                TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(10)
        );

        LanDispatcher.RequestRunner throwingRunner = (url, body, ct, ctMs, rtMs, deadline, maxBytes, sched) -> {
            throw new IOException("network exploded");
        };

        LanDispatcher dispatcherThrowing = new LanDispatcher(executor, scheduler, System::nanoTime, throwingRunner);

        AtomicInteger failCalls = new AtomicInteger(0);
        AtomicInteger okCalls = new AtomicInteger(0);
        AtomicReference<String> errorMsg = new AtomicReference<>();
        CountDownLatch failLatch = new CountDownLatch(1);

        dispatcherThrowing.submit(
                new LanDispatcher.Request("http://127.0.0.1/fail", null, null, 1000, 1000, 1024),
                5000,
                new LanDispatcher.Callback() {
                    @Override
                    public void ok(LanRequest.Result r) {
                        okCalls.incrementAndGet();
                    }

                    @Override
                    public void fail(String message) {
                        failCalls.incrementAndGet();
                        errorMsg.set(message);
                        failLatch.countDown();
                    }
                }
        );

        assertTrue("Failing request must call cb.fail", failLatch.await(5, TimeUnit.SECONDS));
        assertEquals(1, failCalls.get());
        assertEquals(0, okCalls.get());
        assertEquals("network exploded", errorMsg.get());

        LanDispatcher.RequestRunner successRunner = (url, body, ct, ctMs, rtMs, deadline, maxBytes, sched) ->
                new LanRequest.Result(200, new byte[]{1, 2, 3});

        LanDispatcher dispatcherSuccess = new LanDispatcher(executor, scheduler, System::nanoTime, successRunner);

        AtomicInteger okSuccessCalls = new AtomicInteger(0);
        AtomicInteger failSuccessCalls = new AtomicInteger(0);
        AtomicReference<LanRequest.Result> resultRef = new AtomicReference<>();
        CountDownLatch successLatch = new CountDownLatch(1);

        dispatcherSuccess.submit(
                new LanDispatcher.Request("http://127.0.0.1/ok", null, null, 1000, 1000, 1024),
                5000,
                new LanDispatcher.Callback() {
                    @Override
                    public void ok(LanRequest.Result r) {
                        okSuccessCalls.incrementAndGet();
                        resultRef.set(r);
                        successLatch.countDown();
                    }

                    @Override
                    public void fail(String message) {
                        failSuccessCalls.incrementAndGet();
                    }
                }
        );

        assertTrue("Successful request must call cb.ok", successLatch.await(5, TimeUnit.SECONDS));
        assertEquals(1, okSuccessCalls.get());
        assertEquals(0, failSuccessCalls.get());
        assertEquals(200, resultRef.get().status);

        executor.shutdownNow();
    }
}
