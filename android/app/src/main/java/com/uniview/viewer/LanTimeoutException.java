package com.uniview.viewer;

import java.io.IOException;

public class LanTimeoutException extends IOException {
    public LanTimeoutException(String message) {
        super(message);
    }

    public LanTimeoutException(String message, Throwable cause) {
        super(message, cause);
    }
}
