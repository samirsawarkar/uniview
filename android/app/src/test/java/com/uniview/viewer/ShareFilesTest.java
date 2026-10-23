package com.uniview.viewer;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import org.junit.Test;

public class ShareFilesTest {
    @Test
    public void namesLoseSeparatorsAndUrlMarkers() {
        assertEquals("report_1.pdf", ShareFiles.safeName("report#1.pdf"));
        assertEquals("a_b_c.txt", ShareFiles.safeName("a/b\\c.txt"));
        assertEquals("100_ done.docx", ShareFiles.safeName("100% done.docx"));
        assertEquals("_.hidden", ShareFiles.safeName(".hidden"));
        assertEquals("shared-file", ShareFiles.safeName(".."));
        assertEquals("shared-file", ShareFiles.safeName(null));
        assertEquals("tab_here", ShareFiles.safeName("tab\there"));
        assertEquals(120, ShareFiles.safeName(new String(new char[300]).replace('\0', 'x')).length());
    }

    @Test
    public void urlsEncodeEverySegment() {
        String url = ShareFiles.localFileUrl("https://localhost", "/data/user/0/com.uniview.viewer/cache/shared/1/my report?.pdf");
        assertEquals("https://localhost/_capacitor_file_/data/user/0/com.uniview.viewer/cache/shared/1/my%20report%3F.pdf", url);
        String hash = ShareFiles.localFileUrl("https://localhost/", "/c/a#b.pdf");
        assertEquals("https://localhost/_capacitor_file_/c/a%23b.pdf", hash);
        assertFalse(hash.contains("#"));
    }
}
