package com.uniview.viewer;

import java.net.URI;

final class SharedRange {
    static final long MAX_SPAN = 8L * 1024 * 1024;
    final int status;
    final long start;
    final long end;
    final boolean close;

    SharedRange(int status, long start, long end, boolean close) {
        this.status = status;
        this.start = start;
        this.end = end;
        this.close = close;
    }

    static boolean isSharedUrl(String localUrl, String requestUrl) {
        if (localUrl == null || requestUrl == null) {
            return false;
        }
        URI localUri;
        URI reqUri;
        try {
            localUri = new URI(localUrl);
            reqUri = new URI(requestUrl);
        } catch (Exception e) {
            return false;
        }
        String localScheme = localUri.getScheme();
        String reqScheme = reqUri.getScheme();
        if (localScheme == null || reqScheme == null || !localScheme.equalsIgnoreCase(reqScheme)) {
            return false;
        }
        String localHost = localUri.getHost();
        String reqHost = reqUri.getHost();
        if (localHost == null || reqHost == null || !localHost.equalsIgnoreCase(reqHost)) {
            return false;
        }
        if (effectivePort(localUri) != effectivePort(reqUri)) {
            return false;
        }
        if (reqUri.getUserInfo() != null || reqUri.getRawUserInfo() != null) {
            return false;
        }
        String rawPath = reqUri.getRawPath();
        if (rawPath == null || !rawPath.startsWith("/_uniview_shared/")) {
            return false;
        }
        return true;
    }

    private static int effectivePort(URI uri) {
        int port = uri.getPort();
        if (port != -1) {
            return port;
        }
        String scheme = uri.getScheme();
        if (scheme != null) {
            if ("https".equalsIgnoreCase(scheme)) {
                return 443;
            }
            if ("http".equalsIgnoreCase(scheme)) {
                return 80;
            }
        }
        return -1;
    }

    static SharedRange parse(String query, long size) {
        if (query == null) {
            return new SharedRange(400, 0, 0, false);
        }
        if (query.startsWith("?")) {
            query = query.substring(1);
        }
        if (query.isEmpty()) {
            return new SharedRange(400, 0, 0, false);
        }

        String[] parts = query.split("&", -1);
        String startVal = null;
        String endVal = null;
        String closeVal = null;

        for (String part : parts) {
            if (part.isEmpty()) {
                return new SharedRange(400, 0, 0, false);
            }
            String[] kv = part.split("=", -1);
            if (kv.length != 2 || kv[0].isEmpty() || kv[1].isEmpty()) {
                return new SharedRange(400, 0, 0, false);
            }
            String key = kv[0];
            String val = kv[1];
            if ("start".equals(key)) {
                if (startVal != null) {
                    return new SharedRange(400, 0, 0, false);
                }
                startVal = val;
            } else if ("end".equals(key)) {
                if (endVal != null) {
                    return new SharedRange(400, 0, 0, false);
                }
                endVal = val;
            } else if ("close".equals(key)) {
                if (closeVal != null) {
                    return new SharedRange(400, 0, 0, false);
                }
                closeVal = val;
            } else {
                return new SharedRange(400, 0, 0, false);
            }
        }

        if (closeVal != null) {
            if (startVal != null || endVal != null) {
                return new SharedRange(400, 0, 0, false);
            }
            if (!"1".equals(closeVal)) {
                return new SharedRange(400, 0, 0, false);
            }
            return new SharedRange(204, 0, 0, true);
        }

        if (startVal == null || endVal == null || size < 0) {
            return new SharedRange(400, 0, 0, false);
        }

        if (!isDigits18(startVal) || !isDigits18(endVal)) {
            return new SharedRange(400, 0, 0, false);
        }

        long start = Long.parseLong(startVal);
        long end = Long.parseLong(endVal);

        if (end < start) {
            return new SharedRange(400, 0, 0, false);
        }

        if (end - start > MAX_SPAN) {
            return new SharedRange(400, 0, 0, false);
        }

        if (start >= size) {
            return new SharedRange(200, size, size, false);
        }

        long clampedEnd = Math.min(end, size);
        return new SharedRange(200, start, clampedEnd, false);
    }

    private static boolean isDigits18(String s) {
        if (s == null || s.isEmpty() || s.length() > 18) {
            return false;
        }
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < '0' || c > '9') {
                return false;
            }
        }
        return true;
    }
}
