package com.uniview.viewer;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class LanUrlTest {

    @Test
    public void testAllowedUrls() {
        assertTrue(LanUrl.isAllowed("http://192.168.1.35:47823/v1/hello"));
        assertTrue(LanUrl.isAllowed("http://10.0.0.1:47823/v1/pair"));
        assertTrue(LanUrl.isAllowed("http://172.16.0.1:47823/v1/session"));
        assertTrue(LanUrl.isAllowed("http://172.31.255.255:47823/v1/rpc"));
        assertTrue(LanUrl.isAllowed("http://127.0.0.1:47823/v1/rpc"));
        assertTrue(LanUrl.isAllowed("http://[::1]:47823/v1/rpc"));
        assertTrue(LanUrl.isAllowed("http://[fd00::1]:47823/v1/rpc"));
        assertTrue(LanUrl.isAllowed("http://[fe80::1]:47823/v1/rpc"));
    }

    @Test
    public void testRejectedSchemes() {
        assertFalse(LanUrl.isAllowed("https://192.168.1.35:47823/v1/hello"));
        assertFalse(LanUrl.isAllowed("ftp://192.168.1.35:47823/v1/hello"));
        assertFalse(LanUrl.isAllowed("ws://192.168.1.35:47823/v1/hello"));
    }

    @Test
    public void testRejectedUserInfoQueryFragment() {
        assertFalse(LanUrl.isAllowed("http://user@192.168.1.35:47823/v1/rpc"));
        assertFalse(LanUrl.isAllowed("http://user:pass@192.168.1.35:47823/v1/rpc"));
        assertFalse(LanUrl.isAllowed("http://192.168.1.35:47823/v1/rpc?x=1"));
        assertFalse(LanUrl.isAllowed("http://192.168.1.35:47823/v1/rpc#section"));
    }

    @Test
    public void testRejectedHosts() {
        assertFalse(LanUrl.isAllowed("http://8.8.8.8:47823/v1/rpc"));
        assertFalse(LanUrl.isAllowed("http://example.com:47823/v1/rpc"));
        assertFalse(LanUrl.isAllowed("http://169.254.1.1:47823/v1/rpc"));
        assertFalse(LanUrl.isAllowed("http://100.64.1.1:47823/v1/rpc"));
        assertFalse(LanUrl.isAllowed("http://0x7f.1:47823/v1/rpc"));
        assertFalse(LanUrl.isAllowed("http://010.0.0.1:47823/v1/rpc"));
        assertFalse(LanUrl.isAllowed("http://[2001:db8::1]:47823/v1/rpc"));
        assertFalse(LanUrl.isAllowed("http://[fe80::1%25wlan0]:47823/v1/rpc"));
        assertFalse(LanUrl.isAllowed("http://[fe80::1%wlan0]:47823/v1/rpc"));
    }

    @Test
    public void testRejectedPorts() {
        assertFalse(LanUrl.isAllowed("http://192.168.1.35/v1/rpc"));
        assertFalse(LanUrl.isAllowed("http://192.168.1.35:0/v1/rpc"));
        assertFalse(LanUrl.isAllowed("http://192.168.1.35:65536/v1/rpc"));
        assertFalse(LanUrl.isAllowed("http://192.168.1.35:-1/v1/rpc"));
    }

    @Test
    public void testRejectedPaths() {
        assertFalse(LanUrl.isAllowed("http://192.168.1.35:47823/"));
        assertFalse(LanUrl.isAllowed("http://192.168.1.35:47823/v1/other"));
        assertFalse(LanUrl.isAllowed("http://192.168.1.35:47823/v2/rpc"));
        assertFalse(LanUrl.isAllowed("http://192.168.1.35:47823"));
    }

    @Test
    public void testNullAndEmpty() {
        assertFalse(LanUrl.isAllowed(null));
        assertFalse(LanUrl.isAllowed(""));
        assertFalse(LanUrl.isAllowed("not a url"));
    }
}
