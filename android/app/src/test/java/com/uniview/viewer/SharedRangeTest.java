package com.uniview.viewer;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class SharedRangeTest {

    @Test
    public void testNormalRange() {
        SharedRange r = SharedRange.parse("start=0&end=1024", 10000);
        assertEquals(200, r.status);
        assertEquals(0, r.start);
        assertEquals(1024, r.end);
        assertFalse(r.close);
    }

    @Test
    public void testOrderDoesNotMatter() {
        SharedRange r = SharedRange.parse("end=2048&start=1024", 10000);
        assertEquals(200, r.status);
        assertEquals(1024, r.start);
        assertEquals(2048, r.end);
        assertFalse(r.close);
    }

    @Test
    public void testClampedToSize() {
        SharedRange r = SharedRange.parse("start=0&end=5000", 3000);
        assertEquals(200, r.status);
        assertEquals(0, r.start);
        assertEquals(3000, r.end);
        assertFalse(r.close);
    }

    @Test
    public void testStartAtOrAfterSize() {
        SharedRange r1 = SharedRange.parse("start=3000&end=4000", 3000);
        assertEquals(200, r1.status);
        assertEquals(3000, r1.start);
        assertEquals(3000, r1.end);
        assertFalse(r1.close);

        SharedRange r2 = SharedRange.parse("start=5000&end=6000", 3000);
        assertEquals(200, r2.status);
        assertEquals(3000, r2.start);
        assertEquals(3000, r2.end);
        assertFalse(r2.close);
    }

    @Test
    public void testZeroSize() {
        SharedRange r = SharedRange.parse("start=0&end=0", 0);
        assertEquals(200, r.status);
        assertEquals(0, r.start);
        assertEquals(0, r.end);
        assertFalse(r.close);
    }

    @Test
    public void testMaxSpanAllowed() {
        long max = SharedRange.MAX_SPAN;
        SharedRange r = SharedRange.parse("start=0&end=" + max, 20000000);
        assertEquals(200, r.status);
        assertEquals(0, r.start);
        assertEquals(max, r.end);
        assertFalse(r.close);
    }

    @Test
    public void testSpanExceedingMaxRejected() {
        long max = SharedRange.MAX_SPAN;
        SharedRange r = SharedRange.parse("start=0&end=" + (max + 1), 20000000);
        assertEquals(400, r.status);
    }

    @Test
    public void testReversedRangeRejected() {
        SharedRange r = SharedRange.parse("start=500&end=499", 1000);
        assertEquals(400, r.status);
    }

    @Test
    public void testNegativeBoundsRejected() {
        SharedRange r1 = SharedRange.parse("start=-1&end=100", 1000);
        assertEquals(400, r1.status);

        SharedRange r2 = SharedRange.parse("start=0&end=-100", 1000);
        assertEquals(400, r2.status);
    }

    @Test
    public void testNonDigitsRejected() {
        SharedRange r1 = SharedRange.parse("start=abc&end=100", 1000);
        assertEquals(400, r1.status);

        SharedRange r2 = SharedRange.parse("start=0&end=xyz", 1000);
        assertEquals(400, r2.status);

        SharedRange r3 = SharedRange.parse("start=12a&end=100", 1000);
        assertEquals(400, r3.status);
    }

    @Test
    public void testMoreThan18DigitsRejected() {
        SharedRange r = SharedRange.parse("start=0&end=1000000000000000000", 100000);
        assertEquals(400, r.status);
    }

    @Test
    public void testDuplicateParamsRejected() {
        SharedRange r1 = SharedRange.parse("start=0&end=100&start=5", 1000);
        assertEquals(400, r1.status);

        SharedRange r2 = SharedRange.parse("start=0&end=100&end=200", 1000);
        assertEquals(400, r2.status);

        SharedRange r3 = SharedRange.parse("close=1&close=1", 1000);
        assertEquals(400, r3.status);
    }

    @Test
    public void testMissingBoundsRejected() {
        SharedRange r1 = SharedRange.parse("start=0", 1000);
        assertEquals(400, r1.status);

        SharedRange r2 = SharedRange.parse("end=100", 1000);
        assertEquals(400, r2.status);
    }

    @Test
    public void testCloseSuccess() {
        SharedRange r = SharedRange.parse("close=1", 1000);
        assertEquals(204, r.status);
        assertTrue(r.close);
    }

    @Test
    public void testCloseInvalidValues() {
        SharedRange r1 = SharedRange.parse("close=0", 1000);
        assertEquals(400, r1.status);

        SharedRange r2 = SharedRange.parse("close=2", 1000);
        assertEquals(400, r2.status);

        SharedRange r3 = SharedRange.parse("close=true", 1000);
        assertEquals(400, r3.status);

        SharedRange r4 = SharedRange.parse("close=1&start=0&end=100", 1000);
        assertEquals(400, r4.status);
    }

    @Test
    public void testUnknownParamsRejected() {
        SharedRange r = SharedRange.parse("start=0&end=100&extra=1", 1000);
        assertEquals(400, r.status);
    }

    @Test
    public void testMalformedQuery() {
        assertEquals(400, SharedRange.parse(null, 1000).status);
        assertEquals(400, SharedRange.parse("", 1000).status);
        assertEquals(400, SharedRange.parse("?", 1000).status);
        assertEquals(400, SharedRange.parse("start=0&&end=100", 1000).status);
        assertEquals(400, SharedRange.parse("start", 1000).status);
        assertEquals(400, SharedRange.parse("start=&end=100", 1000).status);
        assertEquals(400, SharedRange.parse("start=0&end=", 1000).status);
        assertEquals(400, SharedRange.parse("start=0=1&end=100", 1000).status);
    }

    @Test
    public void testLeadingQuestionMark() {
        SharedRange r = SharedRange.parse("?start=0&end=100", 1000);
        assertEquals(200, r.status);
        assertEquals(0, r.start);
        assertEquals(100, r.end);
        assertFalse(r.close);
    }

    @Test
    public void testIsSharedUrlAccepted() {
        String token = "0123456789abcdef0123456789abcdef";
        String localUrl = "https://localhost";

        assertTrue(SharedRange.isSharedUrl(localUrl, "https://localhost/_uniview_shared/" + token + "?start=0&end=1"));
        assertTrue(SharedRange.isSharedUrl(localUrl, "https://localhost:443/_uniview_shared/" + token + "?start=0&end=1"));
        assertTrue(SharedRange.isSharedUrl("https://localhost:443", "https://localhost/_uniview_shared/" + token + "?start=0&end=1"));
        assertTrue(SharedRange.isSharedUrl(localUrl, "HTTPS://LOCALHOST/_uniview_shared/" + token + "?start=0&end=1"));
        assertTrue(SharedRange.isSharedUrl("HTTPS://LOCALHOST", "https://localhost/_uniview_shared/" + token + "?start=0&end=1"));
    }

    @Test
    public void testIsSharedUrlRejected() {
        String token = "0123456789abcdef0123456789abcdef";
        String localUrl = "https://localhost";

        assertFalse(SharedRange.isSharedUrl(localUrl, "http://localhost/_uniview_shared/" + token + "?start=0&end=1"));
        // Same effective port, different scheme.
        assertFalse(SharedRange.isSharedUrl(localUrl, "http://localhost:443/_uniview_shared/" + token + "?start=0&end=1"));
        assertFalse(SharedRange.isSharedUrl(localUrl, "https://localhost:8443/_uniview_shared/" + token + "?start=0&end=1"));
        assertFalse(SharedRange.isSharedUrl(localUrl, "https://evil.example/_uniview_shared/" + token + "?start=0&end=1"));
        assertFalse(SharedRange.isSharedUrl(localUrl, "https://localhost.evil.example/_uniview_shared/" + token + "?start=0&end=1"));
        assertFalse(SharedRange.isSharedUrl(localUrl, "https://user@localhost/_uniview_shared/" + token + "?start=0&end=1"));
        assertFalse(SharedRange.isSharedUrl(localUrl, "https://localhost/other/" + token + "?start=0&end=1"));
        assertFalse(SharedRange.isSharedUrl(localUrl, "https://localhost/_uniview_sharedX/" + token + "?start=0&end=1"));
        assertFalse(SharedRange.isSharedUrl(null, "https://localhost/_uniview_shared/" + token + "?start=0&end=1"));
        assertFalse(SharedRange.isSharedUrl(localUrl, null));
        assertFalse(SharedRange.isSharedUrl(null, null));
        assertFalse(SharedRange.isSharedUrl(localUrl, "http://:invalid"));
        assertFalse(SharedRange.isSharedUrl("http://:invalid", "https://localhost/_uniview_shared/" + token));
        assertFalse(SharedRange.isSharedUrl(localUrl, "not a url"));
    }
}
