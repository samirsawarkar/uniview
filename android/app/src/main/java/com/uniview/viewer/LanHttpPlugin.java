package com.uniview.viewer;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(name = "LanHttp")
public class LanHttpPlugin extends Plugin {
    private static final ThreadPoolExecutor WORKERS;
    private static final ScheduledExecutorService SCHEDULER = Executors.newScheduledThreadPool(4);
    private static final int MAX_RESPONSE_LIMIT = 8 * 1024 * 1024 + 64 * 1024;

    static {
        WORKERS = new ThreadPoolExecutor(
            64,
            64,
            30L,
            TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(256)
        );
        WORKERS.allowCoreThreadTimeOut(true);
    }

    @PluginMethod
    public void post(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !LanUrl.isAllowed(url)) {
            call.reject("LAN-only transport: destination not allowed");
            return;
        }

        String bodyB64 = call.getString("body");
        byte[] decodedBody;
        if (bodyB64 != null && !bodyB64.isEmpty()) {
            try {
                decodedBody = Base64.decode(bodyB64, Base64.DEFAULT);
            } catch (Exception e) {
                call.reject("Invalid base64 body: " + e.getMessage());
                return;
            }
        } else {
            decodedBody = new byte[0];
        }

        String contentType = call.getString("contentType");

        Integer connectTimeoutVal = call.getInt("connectTimeoutMs");
        int connectTimeout = clamp(connectTimeoutVal != null ? connectTimeoutVal : 4000, 100, 60000);

        Integer readTimeoutVal = call.getInt("readTimeoutMs");
        int readTimeout = clamp(readTimeoutVal != null ? readTimeoutVal : 20000, 100, 60000);

        Integer deadlineVal = call.getInt("deadlineMs");
        int deadline = clamp(deadlineVal != null ? deadlineVal : 30000, 100, 120000);

        Integer maxBytesVal = call.getInt("maxResponseBytes");
        int maxResponseBytes = clamp(maxBytesVal != null ? maxBytesVal : MAX_RESPONSE_LIMIT, 1, MAX_RESPONSE_LIMIT);

        long deadlineAtNanos = System.nanoTime() + (long) deadline * 1_000_000L;

        try {
            WORKERS.execute(() -> {
                if (System.nanoTime() >= deadlineAtNanos) {
                    call.reject("The computer did not answer in time.");
                    return;
                }

                try {
                    LanRequest.Result result = LanRequest.execute(
                        url,
                        decodedBody,
                        contentType,
                        connectTimeout,
                        readTimeout,
                        deadlineAtNanos,
                        maxResponseBytes,
                        SCHEDULER
                    );

                    String responseB64 = Base64.encodeToString(result.body, Base64.NO_WRAP);
                    JSObject ret = new JSObject();
                    ret.put("status", result.status);
                    ret.put("body", responseB64);
                    call.resolve(ret);
                } catch (LanTimeoutException e) {
                    call.reject("The computer did not answer in time.");
                } catch (Exception e) {
                    call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
                }
            });
        } catch (RejectedExecutionException e) {
            call.reject("Too many requests to the computer.");
        }
    }

    private static int clamp(int val, int min, int max) {
        if (val < min) return min;
        if (val > max) return max;
        return val;
    }
}
