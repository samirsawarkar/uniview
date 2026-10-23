package com.uniview.viewer;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.After;
import org.junit.Test;

import java.io.Closeable;
import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.util.ArrayList;
import java.util.List;

public class SharedFilesTest {

    private static class TrackedCloseable implements Closeable {
        final Closeable delegate;
        boolean closed = false;

        TrackedCloseable(Closeable delegate) {
            this.delegate = delegate;
        }

        @Override
        public void close() throws IOException {
            closed = true;
            if (delegate != null) {
                delegate.close();
            }
        }
    }

    @After
    public void tearDown() {
        SharedFiles.closeAll();
    }

    @Test
    public void testTokenFormatAndDistinctness() throws IOException {
        File f1 = File.createTempFile("test_token1", ".dat");
        File f2 = File.createTempFile("test_token2", ".dat");
        f1.deleteOnExit();
        f2.deleteOnExit();
        try (RandomAccessFile raf1 = new RandomAccessFile(f1, "rw");
             RandomAccessFile raf2 = new RandomAccessFile(f2, "rw")) {
            TrackedCloseable owner1 = new TrackedCloseable(raf1);
            TrackedCloseable owner2 = new TrackedCloseable(raf2);
            String token1 = SharedFiles.register(owner1, raf1.getChannel(), "file1.dat", 0);
            String token2 = SharedFiles.register(owner2, raf2.getChannel(), "file2.dat", 0);

            assertNotNull(token1);
            assertNotNull(token2);
            assertTrue(token1.matches("^[0-9a-f]{32}$"));
            assertTrue(token2.matches("^[0-9a-f]{32}$"));
            assertNotEquals(token1, token2);
        } finally {
            f1.delete();
            f2.delete();
        }
    }

    @Test
    public void testRegisterWhile() throws IOException {
        File f1 = File.createTempFile("test_rw1", ".dat");
        File f2 = File.createTempFile("test_rw2", ".dat");
        f1.deleteOnExit();
        f2.deleteOnExit();
        try (RandomAccessFile raf1 = new RandomAccessFile(f1, "rw");
             RandomAccessFile raf2 = new RandomAccessFile(f2, "rw")) {
            byte[] payload = new byte[]{1, 2, 3, 4};
            raf1.write(payload);

            TrackedCloseable liveOwner = new TrackedCloseable(raf1);
            String token = SharedFiles.registerWhile(() -> true, liveOwner, raf1.getChannel(), "live.bin", payload.length);

            assertNotNull(token);
            assertFalse(liveOwner.closed);
            assertArrayEquals(payload, SharedFiles.read(token, 0, 4));

            int countBefore = SharedFiles.openCount();
            TrackedCloseable deadOwner = new TrackedCloseable(raf2);
            String deadToken = SharedFiles.registerWhile(() -> false, deadOwner, raf2.getChannel(), "dead.bin", 10);

            assertNull(deadToken);
            assertTrue(deadOwner.closed);
            assertEquals(countBefore, SharedFiles.openCount());
        } finally {
            f1.delete();
            f2.delete();
        }
    }

    @Test
    public void testReadOperations() throws IOException {
        File f = File.createTempFile("test_read", ".dat");
        f.deleteOnExit();
        try (RandomAccessFile raf = new RandomAccessFile(f, "rw")) {
            byte[] payload = new byte[]{10, 20, 30, 40, 50, 60, 70, 80, 90, 100};
            raf.write(payload);

            TrackedCloseable owner = new TrackedCloseable(raf);
            String token = SharedFiles.register(owner, raf.getChannel(), "data.bin", payload.length);

            // Exact bytes for a middle range (start=2, end=6 -> bytes at index 2, 3, 4, 5)
            byte[] middle = SharedFiles.read(token, 2, 6);
            assertArrayEquals(new byte[]{30, 40, 50, 60}, middle);

            // Clamped short result at end of file (start=7, end=15 -> bytes at index 7, 8, 9)
            byte[] clamped = SharedFiles.read(token, 7, 15);
            assertArrayEquals(new byte[]{80, 90, 100}, clamped);

            // Empty array for end <= start
            byte[] emptyEqual = SharedFiles.read(token, 4, 4);
            assertNotNull(emptyEqual);
            assertEquals(0, emptyEqual.length);

            byte[] emptyLess = SharedFiles.read(token, 5, 4);
            assertNotNull(emptyLess);
            assertEquals(0, emptyLess.length);

            // null for an unknown token
            assertNull(SharedFiles.read("00000000000000000000000000000000", 0, 4));
        } finally {
            f.delete();
        }
    }

    @Test
    public void testGetSizeAndGetName() throws IOException {
        File f = File.createTempFile("test_meta", ".dat");
        f.deleteOnExit();
        try (RandomAccessFile raf = new RandomAccessFile(f, "rw")) {
            TrackedCloseable owner = new TrackedCloseable(raf);
            String token = SharedFiles.register(owner, raf.getChannel(), "sample.pdf", 4096);

            assertEquals(4096L, SharedFiles.getSize(token));
            assertEquals("sample.pdf", SharedFiles.getName(token));

            assertEquals(-1L, SharedFiles.getSize("unknown_token"));
            assertNull(SharedFiles.getName("unknown_token"));
        } finally {
            f.delete();
        }
    }

    @Test
    public void testCloseLifecycle() throws IOException {
        File f = File.createTempFile("test_close", ".dat");
        f.deleteOnExit();
        try (RandomAccessFile raf = new RandomAccessFile(f, "rw")) {
            TrackedCloseable owner = new TrackedCloseable(raf);
            String token = SharedFiles.register(owner, raf.getChannel(), "test.txt", 100);

            assertFalse(owner.closed);

            // close returns true once then false, closes the owner
            assertTrue(SharedFiles.close(token));
            assertTrue(owner.closed);
            assertFalse(SharedFiles.close(token));

            // later reads return null
            assertNull(SharedFiles.read(token, 0, 10));
        } finally {
            f.delete();
        }
    }

    @Test
    public void testCloseAll() throws IOException {
        File f1 = File.createTempFile("test_ca1", ".dat");
        File f2 = File.createTempFile("test_ca2", ".dat");
        f1.deleteOnExit();
        f2.deleteOnExit();
        try (RandomAccessFile raf1 = new RandomAccessFile(f1, "rw");
             RandomAccessFile raf2 = new RandomAccessFile(f2, "rw")) {
            TrackedCloseable owner1 = new TrackedCloseable(raf1);
            TrackedCloseable owner2 = new TrackedCloseable(raf2);
            SharedFiles.register(owner1, raf1.getChannel(), "f1.txt", 10);
            SharedFiles.register(owner2, raf2.getChannel(), "f2.txt", 20);

            assertEquals(2, SharedFiles.openCount());
            assertFalse(owner1.closed);
            assertFalse(owner2.closed);

            SharedFiles.closeAll();

            assertTrue(owner1.closed);
            assertTrue(owner2.closed);
            assertEquals(0, SharedFiles.openCount());
        } finally {
            f1.delete();
            f2.delete();
        }
    }

    @Test
    public void testEvictionOn65thRegistration() throws IOException {
        List<File> files = new ArrayList<>();
        List<RandomAccessFile> rafs = new ArrayList<>();
        List<TrackedCloseable> owners = new ArrayList<>();
        List<String> tokens = new ArrayList<>();

        try {
            for (int i = 0; i < 65; i++) {
                File f = File.createTempFile("test_evict_" + i, ".dat");
                f.deleteOnExit();
                files.add(f);
                RandomAccessFile raf = new RandomAccessFile(f, "rw");
                rafs.add(raf);
                raf.write(new byte[]{(byte) (i + 1)});
                TrackedCloseable owner = new TrackedCloseable(raf);
                owners.add(owner);
                String token = SharedFiles.register(owner, raf.getChannel(), "file" + i, 1);
                tokens.add(token);
            }

            // Registering 65 files evicts and closes only the first
            assertTrue("First owner should be closed by eviction", owners.get(0).closed);
            for (int i = 1; i < 65; i++) {
                assertFalse("Owner " + i + " should remain open", owners.get(i).closed);
            }

            // First token now reads as null
            assertNull(SharedFiles.read(tokens.get(0), 0, 1));

            // 65th token still reads
            byte[] read65 = SharedFiles.read(tokens.get(64), 0, 1);
            assertNotNull(read65);
            assertEquals(1, read65.length);
            assertEquals((byte) 65, read65[0]);

            assertEquals(64, SharedFiles.openCount());
        } finally {
            SharedFiles.closeAll();
            for (RandomAccessFile raf : rafs) {
                try {
                    raf.close();
                } catch (Throwable ignored) {
                }
            }
            for (File f : files) {
                f.delete();
            }
        }
    }
}
