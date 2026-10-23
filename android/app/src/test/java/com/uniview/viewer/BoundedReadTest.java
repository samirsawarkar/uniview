package com.uniview.viewer;

import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class BoundedReadTest {

    @Test
    public void testExactMaxPasses() throws IOException {
        byte[] data = new byte[100];
        for (int i = 0; i < data.length; i++) {
            data[i] = (byte) (i & 0xff);
        }
        ByteArrayInputStream in = new ByteArrayInputStream(data);
        byte[] result = BoundedRead.readAtMost(in, 100);
        assertArrayEquals(data, result);
    }

    @Test
    public void testUnderMaxPasses() throws IOException {
        byte[] data = new byte[50];
        for (int i = 0; i < data.length; i++) {
            data[i] = (byte) (i & 0xff);
        }
        ByteArrayInputStream in = new ByteArrayInputStream(data);
        byte[] result = BoundedRead.readAtMost(in, 100);
        assertArrayEquals(data, result);
    }

    @Test
    public void testMaxPlusOneThrows() {
        byte[] data = new byte[101];
        ByteArrayInputStream in = new ByteArrayInputStream(data);
        try {
            BoundedRead.readAtMost(in, 100);
            fail("Expected IOException when input exceeds max");
        } catch (IOException e) {
            assertEquals("response too large", e.getMessage());
        }
    }

    @Test
    public void testStreamOf10MiBWithMax1MiBThrowsWithoutReadingItAll() {
        int max = 1024 * 1024;
        long totalBytes = 10L * 1024 * 1024;
        CountingInputStream countingStream = new CountingInputStream(totalBytes);

        try {
            BoundedRead.readAtMost(countingStream, max);
            fail("Expected IOException for 10 MiB stream with 1 MiB max");
        } catch (IOException e) {
            assertEquals("response too large", e.getMessage());
            long bytesRead = countingStream.getBytesRead();
            assertTrue("Bytes read (" + bytesRead + ") must be > max (" + max + ")", bytesRead > max);
            assertTrue("Bytes read (" + bytesRead + ") must stay below max + 64 KiB (" + (max + 65536) + ")",
                    bytesRead <= max + 65536);
        }
    }

    private static class CountingInputStream extends InputStream {
        private final long totalBytes;
        private long bytesRead = 0;

        CountingInputStream(long totalBytes) {
            this.totalBytes = totalBytes;
        }

        @Override
        public int read() {
            if (bytesRead >= totalBytes) {
                return -1;
            }
            bytesRead++;
            return 0;
        }

        @Override
        public int read(byte[] b, int off, int len) {
            if (bytesRead >= totalBytes) {
                return -1;
            }
            long remaining = totalBytes - bytesRead;
            int toRead = (int) Math.min(len, remaining);
            bytesRead += toRead;
            return toRead;
        }

        long getBytesRead() {
            return bytesRead;
        }
    }
}
