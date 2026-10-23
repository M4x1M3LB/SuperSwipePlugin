package com.superswipe;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.RectF;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.ImageView;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

/**
 * LasEr's floating undo/redo button: a small system overlay window over the
 * note. The pen still writes into the note underneath (it has its own path
 * into the notebook); the button answers finger taps, counted here and sent
 * to JS as "laserOverlayTaps" {count}. Hidden windows are made untouchable.
 */
public class LaserOverlayModule extends ReactContextBaseJavaModule {
    private static final long TAP_WINDOW_MS = 350;

    private final Handler main = new Handler(Looper.getMainLooper());

    // Static: the plugin host process outlives a reloaded JS context, so a
    // window from a previous run is found and reused instead of orphaned.
    private static WindowManager wm;
    private static ImageView button;
    private static WindowManager.LayoutParams params;

    /** A delayed show, cancelled when the pen goes down again. */
    private Runnable pendingShow = null;

    private int taps = 0;
    private final Runnable fireTaps = () -> {
        WritableMap payload = Arguments.createMap();
        payload.putInt("count", taps);
        taps = 0;
        emit("laserOverlayTaps", payload);
    };

    public LaserOverlayModule(ReactApplicationContext context) {
        super(context);
    }

    @Override
    public String getName() {
        return "LaserOverlay";
    }

    private void emit(String event, WritableMap payload) {
        try {
            getReactApplicationContext()
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit(event, payload);
        } catch (Exception ignored) {
        }
    }

    private int dp(int v) {
        return Math.round(v * getReactApplicationContext().getResources().getDisplayMetrics().density);
    }

    private boolean allowed() {
        return Build.VERSION.SDK_INT < 23
                || Settings.canDrawOverlays(getReactApplicationContext());
    }

    // ---- Permission -------------------------------------------------------

    @ReactMethod
    public void checkPermission(Promise promise) {
        promise.resolve(allowed());
    }

    @ReactMethod
    public void requestPermission(Promise promise) {
        try {
            Context ctx = getReactApplicationContext();
            Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + ctx.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("PERMISSION_REQUEST_FAILED", e.getMessage(), e);
        }
    }

    // ---- The button -------------------------------------------------------

    /**
     * After delayMs (timed here: the plugin's JS timers can be paused), show
     * the button gap dp to the left of screen point (x, y), its top level
     * with y, kept on screen. A later hide() or showLeftOf() cancels it.
     */
    @ReactMethod
    public void showLeftOf(double x, double y, double gap, double delayMs, Promise promise) {
        main.post(() -> {
            if (pendingShow != null) {
                main.removeCallbacks(pendingShow);
            }
            pendingShow = () -> {
                pendingShow = null;
                try {
                    if (!allowed()) {
                        return;
                    }
                    ensureButton();
                    DisplayMetrics m = getReactApplicationContext().getResources().getDisplayMetrics();
                    int size = dp(48);
                    int left = (int) Math.round(x) - dp((int) Math.round(gap)) - size;
                    params.x = clamp(left, 0, Math.max(0, m.widthPixels - size));
                    params.y = clamp((int) Math.round(y), 0, Math.max(0, m.heightPixels - size));
                    params.flags &= ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
                    button.setVisibility(View.VISIBLE);
                    wm.updateViewLayout(button, params);
                } catch (Exception ignored) {
                }
            };
            main.postDelayed(pendingShow, Math.max(0, (long) delayMs));
            promise.resolve(allowed());
        });
    }

    /** Hide the button (invisible and untouchable; the window is kept). */
    @ReactMethod
    public void hide(Promise promise) {
        main.post(() -> {
            if (pendingShow != null) {
                main.removeCallbacks(pendingShow);
                pendingShow = null;
            }
            try {
                if (button != null && wm != null) {
                    button.setVisibility(View.INVISIBLE);
                    params.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
                    wm.updateViewLayout(button, params);
                }
                promise.resolve(true);
            } catch (Exception e) {
                promise.reject("HIDE_FAILED", e.getMessage(), e);
            }
        });
    }

    /** Remove the window altogether. */
    @ReactMethod
    public void remove(Promise promise) {
        main.post(() -> {
            try {
                if (button != null && wm != null) {
                    wm.removeView(button);
                }
            } catch (Exception ignored) {
            }
            button = null;
            promise.resolve(true);
        });
    }

    // Needed by NativeEventEmitter on the JS side.
    @ReactMethod
    public void addListener(String eventName) {
    }

    @ReactMethod
    public void removeListeners(double count) {
    }

    private void ensureButton() {
        if (button != null && button.isAttachedToWindow()) {
            return;
        }
        Context ctx = getReactApplicationContext();
        wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        int size = dp(48);
        params = new WindowManager.LayoutParams(
                size, size, type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.START;

        ImageView view = new ImageView(ctx);
        view.setImageBitmap(undoIcon(dp(30)));
        view.setScaleType(ImageView.ScaleType.CENTER);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.WHITE);
        bg.setStroke(dp(2), Color.BLACK);
        bg.setCornerRadius(dp(10));
        view.setBackground(bg);
        view.setOnTouchListener((v, ev) -> {
            // Finger taps only: a pen over the button writes into the note.
            if (ev.getToolType(0) == MotionEvent.TOOL_TYPE_STYLUS) {
                return false;
            }
            if (ev.getActionMasked() == MotionEvent.ACTION_UP) {
                taps++;
                main.removeCallbacks(fireTaps);
                main.postDelayed(fireTaps, TAP_WINDOW_MS);
            }
            return true;
        });
        button = view;
        wm.addView(button, params);
    }

    /** A curved "undo" arrow, drawn so no resources are needed in the host. */
    private Bitmap undoIcon(int size) {
        Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setColor(Color.BLACK);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(size / 10f);
        p.setStrokeCap(Paint.Cap.ROUND);
        float s = size;
        RectF arc = new RectF(s * 0.2f, s * 0.25f, s * 0.85f, s * 0.85f);
        c.drawArc(arc, 180, 200, false, p);
        Path head = new Path();
        head.moveTo(s * 0.08f, s * 0.42f);
        head.lineTo(s * 0.2f, s * 0.58f);
        head.lineTo(s * 0.36f, s * 0.46f);
        c.drawPath(head, p);
        return bmp;
    }

    private static int clamp(int v, int lo, int hi) {
        return Math.max(lo, Math.min(hi, v));
    }
}
