package com.uniview.viewer;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.os.Process;
import android.os.SystemClock;
import android.view.WindowManager;
import android.webkit.WebView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.filters.LargeTest;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Assert;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;

/**
 * Controlled browser session instrumentation test for interactive debugging.
 *
 * <p>Skipped by default during normal connected test runs. To run this session,
 * pass {@code -e uniview_device_session true} to the test runner:
 *
 * <pre>
 * ./gradlew connectedAndroidTest -Pandroid.testInstrumentationRunnerArguments.uniview_device_session=true
 * </pre>
 *
 * or via adb:
 *
 * <pre>
 * adb shell am instrument -w -r \
 *   -e uniview_device_session true \
 *   -e class com.uniview.viewer.DeviceBrowserSessionTest \
 *   com.uniview.viewer.test/androidx.test.runner.AndroidJUnitRunner
 * </pre>
 */
@RunWith(AndroidJUnit4.class)
@LargeTest
public class DeviceBrowserSessionTest {

    private static final String STOP_MARKER_FILENAME = "uniview-device-session.stop";
    private static final int DEFAULT_SESSION_SECONDS = 900;
    private static final int MIN_SESSION_SECONDS = 60;
    private static final int MAX_SESSION_SECONDS = 3600;
    private static final long POLL_INTERVAL_MS = 200L;

    @Test
    public void controlledBrowserSession() throws Exception {
        org.junit.Assume.assumeTrue("Run only with -e uniview_device_session true", "true".equals(InstrumentationRegistry.getArguments().getString("uniview_device_session")));

        Context target = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File markerFile = new File(target.getCacheDir(), STOP_MARKER_FILENAME);

        // Remove only stale stop marker initially
        if (markerFile.exists()) {
            markerFile.delete();
        }

        Bundle args = InstrumentationRegistry.getArguments();
        int sessionSeconds = DEFAULT_SESSION_SECONDS;
        if (args != null) {
            String argVal = args.getString("sessionSeconds");
            if (argVal != null) {
                try {
                    sessionSeconds = Integer.parseInt(argVal.trim());
                } catch (NumberFormatException ignored) {
                }
            }
        }
        if (sessionSeconds < MIN_SESSION_SECONDS) {
            sessionSeconds = MIN_SESSION_SECONDS;
        } else if (sessionSeconds > MAX_SESSION_SECONDS) {
            sessionSeconds = MAX_SESSION_SECONDS;
        }

        ActivityScenario<MainActivity> scenario = null;
        boolean stopped = false;

        try {
            scenario = ActivityScenario.launch(MainActivity.class);

            scenario.onActivity(activity -> {
                activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                Assert.assertNotNull("Capacitor bridge must be initialized", activity.getBridge());
                Assert.assertNotNull("Capacitor webView must be initialized", activity.getBridge().getWebView());
                if ((activity.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
                    WebView.setWebContentsDebuggingEnabled(true);
                }
            });

            int pid = Process.myPid();
            String readinessMessage = "READY pid=" + pid + " marker=" + markerFile.getAbsolutePath();

            Bundle statusBundle = new Bundle();
            statusBundle.putString("stream", readinessMessage + "\n");
            statusBundle.putString("session_status", readinessMessage);
            statusBundle.putInt("pid", pid);
            InstrumentationRegistry.getInstrumentation().sendStatus(0, statusBundle);
            System.out.println("DeviceBrowserSession: " + readinessMessage);

            long monotonicDeadline = SystemClock.elapsedRealtime() + (sessionSeconds * 1000L);

            while (SystemClock.elapsedRealtime() < monotonicDeadline) {
                if (markerFile.exists()) {
                    stopped = true;
                    break;
                }
                SystemClock.sleep(POLL_INTERVAL_MS);
            }

            Assert.assertTrue("Controller stopped before deadline (session timed out without stop marker)", stopped);
        } finally {
            if (scenario != null) {
                try {
                    scenario.onActivity(activity -> {
                        WebView.setWebContentsDebuggingEnabled(false);
                    });
                } catch (Throwable ignored) {
                }
                try {
                    scenario.close();
                } catch (Throwable ignored) {
                }
            }

            if (markerFile.exists()) {
                markerFile.delete();
            }
        }
    }
}
