package com.uniview.viewer;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class LanUrl {
    private static final Pattern IPV4_PATTERN = Pattern.compile(
        "^(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})$"
    );

    private LanUrl() {}

    public static boolean isAllowed(String url) {
        if (url == null || url.isEmpty()) {
            return false;
        }

        if (url.contains("#") || url.contains("?") || url.contains("@") || url.contains("%")) {
            return false;
        }

        URI uri;
        try {
            uri = new URI(url);
        } catch (URISyntaxException e) {
            return false;
        }

        if (!"http".equals(uri.getScheme())) {
            return false;
        }

        if (uri.getUserInfo() != null || uri.getRawUserInfo() != null) {
            return false;
        }
        if (uri.getQuery() != null || uri.getRawQuery() != null) {
            return false;
        }
        if (uri.getFragment() != null || uri.getRawFragment() != null) {
            return false;
        }

        int port = uri.getPort();
        if (port < 1 || port > 65535) {
            return false;
        }

        String path = uri.getRawPath();
        if (path == null) {
            return false;
        }
        if (!path.equals("/v1/pair") && !path.equals("/v1/session") && !path.equals("/v1/rpc") && !path.equals("/v1/hello")) {
            return false;
        }

        String auth = uri.getRawAuthority();
        if (auth == null || auth.isEmpty()) {
            return false;
        }

        String host = uri.getHost();
        if (host == null || host.isEmpty()) {
            return false;
        }

        if (auth.startsWith("[")) {
            int closeBracket = auth.indexOf(']');
            if (closeBracket == -1) {
                return false;
            }
            if (!auth.substring(closeBracket + 1).equals(":" + port)) {
                return false;
            }
            String ipv6Candidate = auth.substring(1, closeBracket);
            return isAllowedIpv6(ipv6Candidate);
        }

        return isAllowedIpv4(host);
    }

    private static boolean isAllowedIpv4(String host) {
        Matcher m = IPV4_PATTERN.matcher(host);
        if (!m.matches()) {
            return false;
        }

        int o0, o1, o2, o3;
        try {
            o0 = Integer.parseInt(m.group(1));
            o1 = Integer.parseInt(m.group(2));
            o2 = Integer.parseInt(m.group(3));
            o3 = Integer.parseInt(m.group(4));
        } catch (NumberFormatException e) {
            return false;
        }

        if (o0 > 255 || o1 > 255 || o2 > 255 || o3 > 255) {
            return false;
        }

        if (o0 == 10) return true;
        if (o0 == 172 && o1 >= 16 && o1 <= 31) return true;
        if (o0 == 192 && o1 == 168) return true;
        if (o0 == 127) return true;

        return false;
    }

    private static boolean isAllowedIpv6(String host) {
        if (host == null || host.isEmpty() || host.contains("%")) {
            return false;
        }

        for (int i = 0; i < host.length(); i++) {
            char c = host.charAt(i);
            boolean isHex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
            if (!isHex && c != ':') {
                return false;
            }
        }

        if (host.contains(":::")) {
            return false;
        }

        int doubleColon = host.indexOf("::");
        if (doubleColon != -1 && host.indexOf("::", doubleColon + 1) != -1) {
            return false;
        }

        String left = "";
        String right = "";
        if (doubleColon != -1) {
            left = host.substring(0, doubleColon);
            right = host.substring(doubleColon + 2);
        } else {
            left = host;
        }

        String[] leftParts = left.isEmpty() ? new String[0] : left.split(":", -1);
        String[] rightParts = right.isEmpty() ? new String[0] : right.split(":", -1);

        if (doubleColon == -1) {
            if (leftParts.length != 8) return false;
        } else {
            if (leftParts.length + rightParts.length >= 8) return false;
        }

        int[] words = new int[8];
        for (int i = 0; i < leftParts.length; i++) {
            if (leftParts[i].isEmpty() || leftParts[i].length() > 4) return false;
            try {
                words[i] = Integer.parseInt(leftParts[i], 16);
            } catch (NumberFormatException e) {
                return false;
            }
        }

        int fill = 8 - leftParts.length - rightParts.length;
        for (int i = 0; i < rightParts.length; i++) {
            if (rightParts[i].isEmpty() || rightParts[i].length() > 4) return false;
            try {
                words[leftParts.length + fill + i] = Integer.parseInt(rightParts[i], 16);
            } catch (NumberFormatException e) {
                return false;
            }
        }

        boolean isLoopback = true;
        for (int i = 0; i < 7; i++) {
            if (words[i] != 0) {
                isLoopback = false;
                break;
            }
        }
        if (isLoopback && words[7] == 1) {
            return true;
        }

        int firstWord = words[0];

        if ((firstWord & 0xfe00) == 0xfc00) {
            return true;
        }

        if ((firstWord & 0xffc0) == 0xfe80) {
            return true;
        }

        return false;
    }
}
