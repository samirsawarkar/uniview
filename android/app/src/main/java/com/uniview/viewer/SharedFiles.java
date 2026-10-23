package com.uniview.viewer;

import android.os.ParcelFileDescriptor;

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

public final class SharedFiles {
    private static final int MAX_ENTRIES = 64;
    private static final Map<String, Entry> REGISTRY = new LinkedHashMap<>();
    private static final SecureRandom RANDOM = new SecureRandom();

    private SharedFiles() {}

    private static final class Entry {
        final ParcelFileDescriptor pfd;
        final FileInputStream fis;
        final FileChannel channel;
        final String name;
        final long size;

        Entry(ParcelFileDescriptor pfd, FileInputStream fis, FileChannel channel, String name, long size) {
            this.pfd = pfd;
            this.fis = fis;
            this.channel = channel;
            this.name = name;
            this.size = size;
        }

        void close() {
            try {
                channel.close();
            } catch (Throwable ignored) {
            }
            try {
                fis.close();
            } catch (Throwable ignored) {
            }
            try {
                pfd.close();
            } catch (Throwable ignored) {
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

    public static String register(ParcelFileDescriptor pfd, String name, long size) {
        if (pfd == null) {
            throw new IllegalArgumentException("pfd cannot be null");
        }
        FileInputStream fis = new FileInputStream(pfd.getFileDescriptor());
        FileChannel channel = fis.getChannel();
        Entry entry = new Entry(pfd, fis, channel, name, size);
        List<Entry> toClose = new ArrayList<>();
        String token;
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

    public static long size(String token) {
        return getSize(token);
    }

    public static String getName(String token) {
        synchronized (REGISTRY) {
            Entry entry = REGISTRY.get(token);
            return entry != null ? entry.name : null;
        }
    }
}
