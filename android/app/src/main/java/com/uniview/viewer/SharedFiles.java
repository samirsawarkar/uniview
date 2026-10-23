package com.uniview.viewer;

import android.os.ParcelFileDescriptor;

import java.io.Closeable;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;

public final class SharedFiles {
    private static final int MAX_ENTRIES = 64;
    private static final Map<String, Entry> REGISTRY = new LinkedHashMap<>();
    private static final SecureRandom RANDOM = new SecureRandom();

    private SharedFiles() {}

    private static final class Entry {
        final Closeable owner;
        final FileChannel channel;
        final String name;
        final long size;

        Entry(Closeable owner, FileChannel channel, String name, long size) {
            this.owner = owner;
            this.channel = channel;
            this.name = name;
            this.size = size;
        }

        void close() {
            if (channel != null) {
                try {
                    channel.close();
                } catch (Throwable ignored) {
                }
            }
            if (owner != null) {
                try {
                    owner.close();
                } catch (Throwable ignored) {
                }
            }
        }
    }

    private static String generateToken() {
        byte[] bytes = new byte[16];
        RANDOM.nextBytes(bytes);
        StringBuilder sb = new StringBuilder(32);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >> 4) & 0x0f, 16));
            sb.append(Character.forDigit(b & 0x0f, 16));
        }
        return sb.toString();
    }

    static String register(Closeable owner, FileChannel channel, String name, long size) {
        Entry entry = new Entry(owner, channel, name, size);
        List<Entry> toClose = new ArrayList<>();
        String token;
        // The 65th open closes the oldest file; a tab still showing it gets 404s and reports a read error.
        synchronized (REGISTRY) {
            while (REGISTRY.size() >= MAX_ENTRIES) {
                Iterator<Map.Entry<String, Entry>> it = REGISTRY.entrySet().iterator();
                if (it.hasNext()) {
                    toClose.add(it.next().getValue());
                    it.remove();
                }
            }
            do {
                token = generateToken();
            } while (REGISTRY.containsKey(token));
            REGISTRY.put(token, entry);
        }
        for (Entry e : toClose) {
            e.close();
        }
        return token;
    }

    static String registerWhile(BooleanSupplier live, Closeable owner, FileChannel channel, String name, long size) {
        String token = register(owner, channel, name, size);
        if (live != null && !live.getAsBoolean()) {
            close(token);
            return null;
        }
        return token;
    }

    public static String register(ParcelFileDescriptor pfd, String name, long size) throws IOException {
        return registerWhile(() -> true, pfd, name, size);
    }

    public static String registerWhile(BooleanSupplier live, ParcelFileDescriptor pfd, String name, long size) throws IOException {
        if (pfd == null) {
            throw new IllegalArgumentException("pfd cannot be null");
        }
        FileInputStream fis = new FileInputStream(pfd.getFileDescriptor());
        FileChannel channel = fis.getChannel();
        try {
            channel.position(0);
        } catch (IOException e) {
            try {
                fis.close();
            } catch (Throwable ignored) {
            }
            throw e;
        }
        Closeable owner = () -> {
            try {
                fis.close();
            } catch (Throwable ignored) {
            }
            try {
                pfd.close();
            } catch (Throwable ignored) {
            }
        };
        return registerWhile(live, owner, channel, name, size);
    }

    // A read racing a close may throw ClosedChannelException; the web client turns
    // it into a 500, which the page reports as a read error.
    public static byte[] read(String token, long start, long end) throws IOException {
        Entry entry;
        synchronized (REGISTRY) {
            entry = REGISTRY.get(token);
        }
        if (entry == null) {
            return null;
        }
        if (end <= start) {
            return new byte[0];
        }
        int len = (int) (end - start);
        byte[] data = new byte[len];
        ByteBuffer buffer = ByteBuffer.wrap(data);
        long pos = start;
        while (buffer.hasRemaining()) {
            int n = entry.channel.read(buffer, pos);
            if (n <= 0) {
                break;
            }
            pos += n;
        }
        if (buffer.position() == len) {
            return data;
        }
        return Arrays.copyOf(data, buffer.position());
    }

    public static boolean close(String token) {
        Entry entry;
        synchronized (REGISTRY) {
            entry = REGISTRY.remove(token);
        }
        if (entry != null) {
            entry.close();
            return true;
        }
        return false;
    }

    public static void closeAll() {
        List<Entry> entries;
        synchronized (REGISTRY) {
            entries = new ArrayList<>(REGISTRY.values());
            REGISTRY.clear();
        }
        for (Entry entry : entries) {
            entry.close();
        }
    }

    public static long getSize(String token) {
        synchronized (REGISTRY) {
            Entry entry = REGISTRY.get(token);
            return entry != null ? entry.size : -1L;
        }
    }

    public static String getName(String token) {
        synchronized (REGISTRY) {
            Entry entry = REGISTRY.get(token);
            return entry != null ? entry.name : null;
        }
    }

    static int openCount() {
        synchronized (REGISTRY) {
            return REGISTRY.size();
        }
    }
}
