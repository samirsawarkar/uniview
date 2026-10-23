package com.uniview.viewer;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class IntentGateTest {

    @Test
    public void testFirstTime() {
        IntentGate gate = new IntentGate();

        // null -> false
        assertFalse(gate.firstTime(null));

        // first object -> true
        Object first = new String("launch_intent");
        assertTrue(gate.firstTime(first));

        // same object again -> false
        assertFalse(gate.firstTime(first));

        // a different but equal-looking object -> true
        Object second = new String("launch_intent");
        assertTrue(gate.firstTime(second));

        // after that, the first object again -> true (only the last one is remembered)
        assertTrue(gate.firstTime(first));
    }

    @Test
    public void testNullDoesNotReset() {
        IntentGate gate = new IntentGate();
        Object first = new Object();

        assertTrue(gate.firstTime(first));
        assertFalse(gate.firstTime(null));
        assertFalse(gate.firstTime(first));
    }
}
