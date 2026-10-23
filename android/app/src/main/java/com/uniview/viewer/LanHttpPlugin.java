package com.uniview.viewer;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "LanHttp")
public class LanHttpPlugin extends Plugin {
    private static final LanDispatcher DISPATCHER = LanDispatcher.createDefault();
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

        LanDispatcher.Request req = new LanDispatcher.Request(
                url,
                decodedBody,
                contentType,
                connectTimeout,
                readTimeout,
                maxResponseBytes
        );

        DISPATCHER.submit(req, deadline, new LanDispatcher.Callback() {
            @Override
            public void ok(LanRequest.Result result) {
                String responseB64 = Base64.encodeToString(result.body, Base64.NO_WRAP);
                JSObject ret = new JSObject();
                ret.put("status", result.status);
                ret.put("body", responseB64);
                call.resolve(ret);
            }

            @Override
            public void fail(String message) {
                call.reject(message);
            }
        });
    }

    private static int clamp(int val, int min, int max) {
        if (val < min) return min;
        if (val > max) return max;
        return val;
    }
}
