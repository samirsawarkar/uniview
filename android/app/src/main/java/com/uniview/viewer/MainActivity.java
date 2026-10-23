package com.uniview.viewer;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Log;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Hands files from "Open with" (ACTION_VIEW) and the share sheet (ACTION_SEND) to the web UI.
 * Each file is copied into a private cache folder and passed to window.__univiewOpenUrl as a
 * same-origin Capacitor file URL, so the page reads it with fetch() and no storage permission.
 */
public class MainActivity extends BridgeActivity {
    private static final String TAG = "UniView";
    private static final long MAX_BYTES = 2L * 1024 * 1024 * 1024;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    /** Scripts waiting for the UI page to finish loading (a cold start from a share). */
    private final List<String> waiting = new ArrayList<>();
    private boolean pageLoaded = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView webView) {
                pageLoaded = true;
                for (String js : waiting) webView.evaluateJavascript(js, null);
                waiting.clear();
            }
        });
        clearOldShares();
        handle(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handle(intent);
    }

    private void handle(Intent intent) {
        if (intent == null) return;
        Uri uri = null;
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) {
            uri = intent.getData();
        } else if (Intent.ACTION_SEND.equals(action)) {
            uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        }
        if (uri == null) return;
        final Uri source = uri;
        final String mime = intent.getType();
        io.execute(() -> deliver(source, mime));
    }

    private void deliver(Uri uri, String mime) {
        try {
            String name = displayName(uri);
            File dir = new File(getCacheDir(), "shared/" + System.currentTimeMillis());
            if (!dir.mkdirs() && !dir.isDirectory()) throw new IllegalStateException("cannot create cache folder");
            File out = new File(dir, ShareFiles.safeName(name));
            ContentResolver resolver = getContentResolver();
            long total = 0;
            try (InputStream in = resolver.openInputStream(uri); OutputStream os = new FileOutputStream(out)) {
                if (in == null) throw new IllegalStateException("no data");
                byte[] buf = new byte[256 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    total += n;
                    if (total > MAX_BYTES) throw new IllegalStateException("file larger than 2 GB");
                    os.write(buf, 0, n);
                }
            }
            String url = ShareFiles.localFileUrl(getBridge().getLocalUrl(), out.getAbsolutePath());
            String js = "(function(u,n,m){if(window.__univiewOpenUrl){window.__univiewOpenUrl(u,n,m)}else{"
                    + "(window.__univiewPending=window.__univiewPending||[]).push({url:u,name:n,mime:m})}})("
                    + JSONObject.quote(url) + "," + JSONObject.quote(name) + "," + JSONObject.quote(mime == null ? "" : mime) + ")";
            runOnUiThread(() -> {
                WebView web = getBridge().getWebView();
                if (pageLoaded && web != null) web.evaluateJavascript(js, null);
                else waiting.add(js);
            });
        } catch (Exception e) {
            Log.w(TAG, "Could not open shared file", e);
        }
    }

    private String displayName(Uri uri) {
        if ("content".equals(uri.getScheme())) {
            try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    String n = c.getString(0);
                    if (n != null && !n.isEmpty()) return n;
                }
            } catch (Exception ignored) {
            }
        }
        String last = uri.getLastPathSegment();
        return last != null && !last.isEmpty() ? last : "shared-file";
    }

    /** Shared copies are temporary; drop ones from earlier sessions. */
    private void clearOldShares() {
        io.execute(() -> deleteTree(new File(getCacheDir(), "shared")));
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
