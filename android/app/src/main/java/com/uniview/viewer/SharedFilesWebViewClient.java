package com.uniview.viewer;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;

public class SharedFilesWebViewClient extends BridgeWebViewClient {
    private static final Pattern TOKEN_PATTERN = Pattern.compile("^[0-9a-f]{32}$");
    private final Bridge bridge;

    public SharedFilesWebViewClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        if (request == null || !"GET".equalsIgnoreCase(request.getMethod())) {
            return super.shouldInterceptRequest(view, request);
        }
        Uri uri = request.getUrl();
        if (uri == null) {
            return super.shouldInterceptRequest(view, request);
        }
        String localUrl = bridge.getLocalUrl();
        if (!SharedRange.isSharedUrl(localUrl, uri.toString())) {
            return super.shouldInterceptRequest(view, request);
        }

        // Subresource fetches are never main-frame requests, so isForMainFrame()
        // is not a usable check; a cross-origin frame cannot read the response
        // (no CORS headers are sent) and tokens are 128-bit random.
        String path = uri.getPath();
        String token = (path != null && path.startsWith("/_uniview_shared/"))
                ? path.substring("/_uniview_shared/".length())
                : "";
        if (!TOKEN_PATTERN.matcher(token).matches()) {
            return response(404, "Not Found", new byte[0]);
        }

        long size = SharedFiles.getSize(token);
        if (size < 0) {
            return response(404, "Not Found", new byte[0]);
        }

        String query = uri.getQuery();
        SharedRange range = SharedRange.parse(query, size);
        if (range.status == 204) {
            SharedFiles.close(token);
            return response(204, "No Content", new byte[0]);
        }
        if (range.status != 200) {
            return response(range.status, "Bad Request", new byte[0]);
        }

        try {
            byte[] bytes = SharedFiles.read(token, range.start, range.end);
            if (bytes == null) {
                return response(404, "Not Found", new byte[0]);
            }
            return response(200, "OK", bytes);
        } catch (IOException e) {
            return response(500, "Internal Server Error", new byte[0]);
        }
    }

    private WebResourceResponse response(int status, String reason, byte[] body) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        InputStream in = new ByteArrayInputStream(body != null ? body : new byte[0]);
        return new WebResourceResponse("application/octet-stream", null, status, reason, headers, in);
    }
}
