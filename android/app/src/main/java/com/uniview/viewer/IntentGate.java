package com.uniview.viewer;

public class IntentGate {
    private Object lastHandled;

    public boolean firstTime(Object intent) {
        if (intent == null || intent == lastHandled) {
            return false;
        }
        lastHandled = intent;
        return true;
    }
}
