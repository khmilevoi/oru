package com.oru.radio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import com.oru.R

/**
 * Spec section 10.1: the radio lives in a foreground service with the microphone and
 * connectedDevice types, so it keeps running while the RN Activity is destroyed and while the
 * screen is locked.
 *
 * Routing is not this class's job any more. Section 6 of the 2026-08-18 headphone design moved
 * every audio decision into [AudioRouteController], which runs on its own `audio-route` thread
 * and is driven by [RadioEngine]; this service only builds the objects and owns their threads.
 */
class RadioForegroundService : Service() {

    companion object {
        const val ACTION_START = "com.oru.radio.action.START"
        const val ACTION_STOP = "com.oru.radio.action.STOP"
        private const val CHANNEL_ID = "oru.radio"
        private const val NOTIFICATION_ID = 1
        private const val TAG = "OruRadio"
    }

    private var scheduler: HandlerScheduler? = null
    private var routeScheduler: HandlerScheduler? = null
    private var engine: RadioEngine? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()

        val scheduler = HandlerScheduler()
        // Section 6: a dedicated HandlerThread("audio-route"); every platform callback is
        // registered against its handler and every controller entry point posts onto it, so
        // the route state machine is single-threaded by construction.
        val routeScheduler = HandlerScheduler("audio-route")
        val routing = AudioRouteController(
            facade = AndroidAudioManagerFacade(this, routeScheduler.handler()),
            scheduler = routeScheduler,
            // Monotonic, never a wall clock: a system time change must not move a dwell deadline.
            clock = SystemClock::elapsedRealtime,
            policy = ModePolicy(),
            logger = AndroidRouteLogger(),
        )
        val engine = RadioEngine(
            transport = NearbyManager(this, Build.MODEL ?: "Android", scheduler),
            audio = AudioEngine(),
            ptt = PttManager(
                SharedPreferencesPttBindingStore(this),
                AndroidPttDriverFactory(this),
                scheduler,
            ),
            routing = routing,
            scheduler = scheduler,
        )
        // A task that throws its way out of either thread would otherwise unwind Looper.loop()
        // and kill the process; both schedulers catch it and report it here, the one
        // unrecoverable-failure path of spec section 13.
        scheduler.setUncaughtHandler { error ->
            engine.failFromHost("engine_task_failed", error.message ?: error.javaClass.simpleName)
        }
        routeScheduler.setUncaughtHandler { error ->
            engine.failFromHost(
                "audio_route_task_failed",
                error.message ?: error.javaClass.simpleName,
            )
        }
        this.scheduler = scheduler
        this.routeScheduler = routeScheduler
        this.engine = engine
        RadioController.attach(engine)
        // Section 8: the pin is stored natively and applies from the first state the bridge
        // ever publishes, not from the first time JavaScript sets it.
        engine.setAudioMode(SharedPreferencesAudioModeStore(this).load())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // A service started with startForegroundService() must call startForeground()
            // shortly after, even on the path that immediately tears it back down again.
            startForegroundWithTypes()
            engine?.stopRadio()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        if (!startForegroundWithTypes()) {
            engine?.failFromHost(
                "foreground_service_denied",
                "The radio may not run in the foreground; are the microphone and Bluetooth permissions granted?",
            )
            stopSelf()
            return START_NOT_STICKY
        }
        engine?.startRadio()
        Log.i(TAG, "radio service started")
        return START_STICKY
    }

    override fun onDestroy() {
        engine?.stopRadio()
        RadioController.detach()
        // Shut both threads down from inside themselves, and the route thread from inside the
        // engine thread: stopRadio() posted `routing.stop()` onto the route queue from the
        // engine queue, so this ordering guarantees the shutdown lands behind it.
        val route = routeScheduler
        scheduler?.let { current ->
            current.execute {
                route?.execute { route.shutdown() }
                current.shutdown()
            }
        }
        engine = null
        scheduler = null
        routeScheduler = null
        Log.i(TAG, "radio service stopped")
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.radio_notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    /**
     * Returns false when the platform refused the foreground service. From Android 14 a
     * `microphone` type without RECORD_AUDIO granted, or `connectedDevice` without the
     * Bluetooth permissions, throws; every one of those would otherwise propagate out of
     * `onStartCommand` and take the service down with no state, no error event and no log.
     */
    private fun startForegroundWithTypes(): Boolean {
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.radio_notification_title))
            .setContentText(getString(R.string.radio_notification_text))
            .setSmallIcon(android.R.drawable.stat_sys_speakerphone)
            .setOngoing(true)
            .build()

        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            true
        } catch (error: SecurityException) {
            Log.e(TAG, "the foreground service was refused", error)
            false
        } catch (error: IllegalStateException) {
            Log.e(TAG, "the foreground service was refused", error)
            false
        }
    }
}
