package com.uniview.viewer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Executes a LAN HTTP POST request with timeout and response size limits.
 *
 * Race condition resolution:
 * Whichever transition happens first wins.
 */
public final class LanRequest {
    public static final int RUNNING = 0;
    public static final int COMPLETED = 1;
    public static final int TIMED_OUT = 2;

    private LanRequest() {
    }

    public static final class Result {
        public final int status;
        public final byte[] body;

        public Result(int status, byte[] body) {
            this.status = status;
            this.body = body != null ? body : new byte[0];
        }
    }

    static class Hooks {
        void afterBodyRead() {
        }

        void beforeTimeoutCas() {
        }

        void afterTimeoutCas(int stateAfterCas) {
        }
    }

    public static Result execute(
            String url,
            byte[] body,
            String contentType,
            int connectTimeoutMs,
            int readTimeoutMs,
            long deadlineAtNanos,
            int maxResponseBytes,
            ScheduledExecutorService scheduler) throws IOException {
        return execute(
                url,
                body,
                contentType,
                connectTimeoutMs,
                readTimeoutMs,
                deadlineAtNanos,
                maxResponseBytes,
                scheduler,
                new Hooks()
        );
    }

    static Result execute(
            String url,
            byte[] body,
            String contentType,
            int connectTimeoutMs,
            int readTimeoutMs,
            long deadlineAtNanos,
            int maxResponseBytes,
            ScheduledExecutorService scheduler,
            Hooks hooks) throws IOException {
        if (hooks == null) {
            hooks = new Hooks();
        }

        if (url == null || !LanUrl.isAllowed(url)) {
            throw new IOException("LAN-only transport: destination not allowed");
        }

        if (System.nanoTime() >= deadlineAtNanos) {
            throw new LanTimeoutException("The computer did not answer in time.");
        }

        HttpURLConnection conn = null;
        ScheduledFuture<?> deadlineTask = null;
        final AtomicInteger state = new AtomicInteger(RUNNING);
        final Hooks activeHooks = hooks;

        try {
            URL targetUrl = new URL(url);
            conn = (HttpURLConnection) targetUrl.openConnection();
            final HttpURLConnection finalConn = conn;

            long remainingNanos = deadlineAtNanos - System.nanoTime();
            if (remainingNanos <= 0) {
                throw new LanTimeoutException("The computer did not answer in time.");
            }

            if (scheduler != null) {
                deadlineTask = scheduler.schedule(() -> {
                    activeHooks.beforeTimeoutCas();
                    if (state.compareAndSet(RUNNING, TIMED_OUT)) {
                        try {
                            finalConn.disconnect();
                        } catch (Exception ignored) {
                        }
                    }
                    activeHooks.afterTimeoutCas(state.get());
                }, remainingNanos, TimeUnit.NANOSECONDS);
            }

            conn.setRequestMethod("POST");
            conn.setInstanceFollowRedirects(false);
            conn.setUseCaches(false);
            conn.setConnectTimeout(connectTimeoutMs);
            conn.setReadTimeout(readTimeoutMs);
            conn.setDoOutput(true);

            if (contentType != null && !contentType.isEmpty()) {
                conn.setRequestProperty("Content-Type", contentType);
            }

            byte[] nonNullBody = body != null ? body : new byte[0];
            conn.setRequestProperty("Content-Length", String.valueOf(nonNullBody.length));

            try (OutputStream os = conn.getOutputStream()) {
                if (nonNullBody.length > 0) {
                    os.write(nonNullBody);
                }
                os.flush();
            }

            int status = conn.getResponseCode();
            InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            byte[] responseBytes;
            if (is != null) {
                try (InputStream stream = is) {
                    responseBytes = BoundedRead.readAtMost(stream, maxResponseBytes);
                }
            } else {
                responseBytes = new byte[0];
            }

            activeHooks.afterBodyRead();
            if (!state.compareAndSet(RUNNING, COMPLETED)) {
                throw new LanTimeoutException("The computer did not answer in time.");
            }

            return new Result(status, responseBytes);
        } catch (Exception e) {
            if (state.get() == TIMED_OUT || e instanceof LanTimeoutException) {
                if (e instanceof LanTimeoutException) {
                    throw (LanTimeoutException) e;
                }
                throw new LanTimeoutException("The computer did not answer in time.", e);
            }
            if (e instanceof IOException) {
                throw (IOException) e;
            }
            throw new IOException(e.getMessage() != null ? e.getMessage() : e.toString(), e);
        } finally {
            if (deadlineTask != null) {
                deadlineTask.cancel(false);
            }
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Exception ignored) {
                }
            }
        }
    }
}
