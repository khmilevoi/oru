package com.oru.radio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import com.oru.R

/**
 * Spec section 10.1: the radio lives in a foreground service with the microphone and
 * connectedDevice types, so it keeps running while the RN Activity is destroyed and while
 * the screen is locked.
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
    private var engine: RadioEngine? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()

        val scheduler = HandlerScheduler()
        val engine = RadioEngine(
            transport = NearbyManager(this, Build.MODEL ?: "Android", scheduler),
            audio = AudioEngine(),
            ptt = PttManager(
                SharedPreferencesPttBindingStore(this),
                AndroidPttDriverFactory(this),
                scheduler,
            ),
            scheduler = scheduler,
        )
        this.scheduler = scheduler
        this.engine = engine
        RadioController.attach(engine)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // A service started with startForegroundService() must call startForeground()
            // shortly after, even on the path that immediately tears it back down again --
            // this is what makes ACTION_STOP the real stop path instead of dead code.
            startForegroundWithTypes()
            engine?.stopRadio()
            setCommunicationMode(false)
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        startForegroundWithTypes()
        setCommunicationMode(true)
        engine?.startRadio()
        Log.i(TAG, "radio service started")
        return START_STICKY
    }

    override fun onDestroy() {
        engine?.stopRadio()
        RadioController.detach()
        setCommunicationMode(false)
        // Shut the thread down from inside itself, so it runs after stopRadio's work.
        scheduler?.let { current -> current.execute { current.shutdown() } }
        engine = null
        scheduler = null
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

    private fun startForegroundWithTypes() {
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.radio_notification_title))
            .setContentText(getString(R.string.radio_notification_text))
            .setSmallIcon(android.R.drawable.stat_sys_speakerphone)
            .setOngoing(true)
            .build()

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
    }

    /**
     * Communication mode is what makes VOICE_COMMUNICATION capture and
     * USAGE_VOICE_COMMUNICATION playback share one echo-cancelled route, and it is what
     * puts the volume keys on the call stream while the radio is live.
     */
    private fun setCommunicationMode(active: Boolean) {
        val audioManager = getSystemService(AudioManager::class.java) ?: return
        audioManager.mode = if (active) AudioManager.MODE_IN_COMMUNICATION else AudioManager.MODE_NORMAL
    }
}
