package com.uniview.viewer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

public final class BoundedRead {
    private static final int BUFFER_SIZE = 8192;

    private BoundedRead() {}

    public static byte[] readAtMost(InputStream in, int max) throws IOException {
        if (in == null) {
            return new byte[0];
        }
        if (max < 0) {
            throw new IllegalArgumentException("max must be non-negative");
        }

        ByteArrayOutputStream out = new ByteArrayOutputStream(Math.min(max, 32768));
        byte[] buf = new byte[BUFFER_SIZE];
        int read;
        while ((read = in.read(buf)) != -1) {
            if ((long) out.size() + read > max) {
                throw new IOException("response too large");
            }
            out.write(buf, 0, read);
        }
        return out.toByteArray();
    }
}
