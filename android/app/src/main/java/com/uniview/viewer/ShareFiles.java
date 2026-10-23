package com.uniview.viewer;

/** Pure helpers for handing shared files to the web UI. Kept free of Android types so they unit-test on the JVM. */
final class ShareFiles {
    private ShareFiles() {}

    /** Characters that are unsafe on disk or inside a URL path. */
    private static final String UNSAFE = "[\\\\/:*?\"<>|#%\\x00-\\x1f]";

    /** A file name safe on disk and inside a URL path: separators, reserved and URL-special characters become "_". */
    static String safeName(String name) {
        if (name == null) name = "";
        String n = name.replaceAll(UNSAFE, "_").trim();
        if (n.isEmpty() || n.equals(".") || n.equals("..")) n = "shared-file";
        if (n.startsWith(".")) n = "_" + n;
        return n.length() > 120 ? n.substring(n.length() - 120) : n;
    }

    /** Percent-encode each path segment so the page can fetch the file whatever characters the path holds. */
    static String encodePath(String absolutePath) {
        StringBuilder out = new StringBuilder();
        for (String seg : absolutePath.split("/")) {
            if (seg.isEmpty()) continue;
            out.append('/');
            try {
                out.append(java.net.URLEncoder.encode(seg, "UTF-8").replace("+", "%20"));
            } catch (java.io.UnsupportedEncodingException e) {
                throw new IllegalStateException(e);
            }
        }
        return out.toString();
    }

    /** The same-origin URL Capacitor serves a local file from. */
    static String localFileUrl(String localUrl, String absolutePath) {
        String base = localUrl.endsWith("/") ? localUrl.substring(0, localUrl.length() - 1) : localUrl;
        return base + "/_capacitor_file_" + encodePath(absolutePath);
    }
}
