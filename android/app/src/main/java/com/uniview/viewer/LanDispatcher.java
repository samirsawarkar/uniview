package com.uniview.viewer;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;

public class LanDispatcher {
    @FunctionalInterface
    public interface RequestRunner {
        LanRequest.Result execute(
                String url,
                byte[] body,
                String contentType,
                int connectTimeoutMs,
                int readTimeoutMs,
                long deadlineAtNanos,
                int maxResponseBytes,
                ScheduledExecutorService scheduler
        ) throws Exception;
    }

    public static final class Request {
        public final String url;
        public final byte[] body;
        public final String contentType;
        public final int connectTimeoutMs;
        public final int readTimeoutMs;
        public final int maxResponseBytes;

        public Request(
                String url,
                byte[] body,
                String contentType,
                int connectTimeoutMs,
                int readTimeoutMs,
                int maxResponseBytes) {
            this.url = url;
            this.body = body != null ? body : new byte[0];
            this.contentType = contentType;
            this.connectTimeoutMs = connectTimeoutMs;
            this.readTimeoutMs = readTimeoutMs;
            this.maxResponseBytes = maxResponseBytes;
        }
    }

    public interface Callback {
        void ok(LanRequest.Result r);
        void fail(String message);
    }

    private final ExecutorService executor;
    private final ScheduledExecutorService scheduler;
    private final LongSupplier nanoClock;
    private final RequestRunner runner;

    public LanDispatcher(ExecutorService executor, ScheduledExecutorService scheduler, LongSupplier nanoClock) {
        this(executor, scheduler, nanoClock, LanRequest::execute);
    }

    LanDispatcher(
            ExecutorService executor,
            ScheduledExecutorService scheduler,
            LongSupplier nanoClock,
            RequestRunner runner) {
        this.executor = executor;
        this.scheduler = scheduler;
        this.nanoClock = nanoClock != null ? nanoClock : System::nanoTime;
        this.runner = runner != null ? runner : LanRequest::execute;
    }

    public static LanDispatcher createDefault() {
        ThreadPoolExecutor workers = new ThreadPoolExecutor(
                64,
                64,
                30L,
                TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(256)
        );
        workers.allowCoreThreadTimeOut(true);
        ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(4);
        return new LanDispatcher(workers, scheduler, System::nanoTime);
    }

    public void submit(Request req, long deadlineMs, Callback cb) {
        long deadlineAt = nanoClock.getAsLong() + deadlineMs * 1_000_000L;
        try {
            executor.execute(() -> {
                if (nanoClock.getAsLong() >= deadlineAt) {
                    cb.fail("The computer did not answer in time.");
                    return;
                }

                try {
                    LanRequest.Result result = runner.execute(
                            req.url,
                            req.body,
                            req.contentType,
                            req.connectTimeoutMs,
                            req.readTimeoutMs,
                            deadlineAt,
                            req.maxResponseBytes,
                            scheduler
                    );
                    cb.ok(result);
                } catch (LanTimeoutException e) {
                    cb.fail("The computer did not answer in time.");
                } catch (Throwable e) {
                    cb.fail(e.getMessage() != null ? e.getMessage() : e.toString());
                }
            });
        } catch (RejectedExecutionException e) {
            cb.fail("Too many requests to the computer.");
        }
    }
}
