package com.uniview.viewer;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "LanHttp")
public class LanHttpPlugin extends Plugin {
    private static final ExecutorService WORKERS = Executors.newFixedThreadPool(64);
    private static final ScheduledExecutorService SCHEDULER = Executors.newScheduledThreadPool(4);
    private static final int MAX_RESPONSE_LIMIT = 8 * 1024 * 1024 + 64 * 1024;

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

        WORKERS.execute(() -> {
            HttpURLConnection conn = null;
            ScheduledFuture<?> deadlineTask = null;
            AtomicBoolean deadlineFired = new AtomicBoolean(false);

            try {
                URL targetUrl = new URL(url);
                conn = (HttpURLConnection) targetUrl.openConnection();
                final HttpURLConnection finalConn = conn;

                deadlineTask = SCHEDULER.schedule(() -> {
                    deadlineFired.set(true);
                    try {
                        finalConn.disconnect();
                    } catch (Exception ignored) {
                    }
                }, deadline, TimeUnit.MILLISECONDS);

                conn.setRequestMethod("POST");
                conn.setInstanceFollowRedirects(false);
                conn.setUseCaches(false);
                conn.setConnectTimeout(connectTimeout);
                conn.setReadTimeout(readTimeout);
                conn.setDoOutput(true);

                if (contentType != null && !contentType.isEmpty()) {
                    conn.setRequestProperty("Content-Type", contentType);
                }
                conn.setRequestProperty("Content-Length", String.valueOf(decodedBody.length));

                try (OutputStream os = conn.getOutputStream()) {
                    if (decodedBody.length > 0) {
                        os.write(decodedBody);
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

                if (deadlineFired.get()) {
                    call.reject("The computer did not answer in time.");
                    return;
                }

                String responseB64 = Base64.encodeToString(responseBytes, Base64.NO_WRAP);
                JSObject ret = new JSObject();
                ret.put("status", status);
                ret.put("body", responseB64);
                call.resolve(ret);
            } catch (Exception e) {
                if (deadlineFired.get()) {
                    call.reject("The computer did not answer in time.");
                } else {
                    call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
                }
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
        });
    }

    private static int clamp(int val, int min, int max) {
        if (val < min) return min;
        if (val > max) return max;
        return val;
    }
}
