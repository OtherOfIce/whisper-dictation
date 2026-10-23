package helium314.keyboard.latin.whisper

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import android.widget.Toast
import androidx.core.content.ContextCompat

/** A microphone foreground service makes temporary audio focus available to the IME on Android 15+. */
class DictationAudioService : Service() {
    private lateinit var audio: AudioManager
    private val listener = AudioManager.OnAudioFocusChangeListener { }
    private var request: AudioFocusRequest? = null
    private var requested = false

    override fun onCreate() {
        super.onCreate()
        audio = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(
                    NotificationChannel(CHANNEL, "Voice input", NotificationManager.IMPORTANCE_LOW)
                )
            }
            val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else {
                @Suppress("DEPRECATION")
                Notification.Builder(this)
            }
            val notification = builder.setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentTitle("Local Whisper voice input")
                .setContentText("Keeping media paused while you dictate")
                .setOngoing(true).build()
            if (Build.VERSION.SDK_INT >= 29) startForeground(3811, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            else startForeground(3811, notification)
            val result = if (Build.VERSION.SDK_INT >= 26) {
                val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                    .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                    .setOnAudioFocusChangeListener(listener).build()
                request = focus
                audio.requestAudioFocus(focus)
            } else {
                @Suppress("DEPRECATION")
                audio.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
            }
            requested = true
            if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                Toast.makeText(this, "This device could not pause background media", Toast.LENGTH_SHORT).show()
                stopSelf()
            }
        } catch (error: Exception) {
            Log.w("DictationAudio", "Could not request temporary audio focus", error)
            Toast.makeText(this, "Background media could not be paused", Toast.LENGTH_SHORT).show()
            stopSelf()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int) = START_NOT_STICKY
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onDestroy() {
        if (requested) runCatching {
            if (Build.VERSION.SDK_INT >= 26) request?.let { audio.abandonAudioFocusRequest(it) }
            else {
                @Suppress("DEPRECATION")
                audio.abandonAudioFocus(listener)
            }
        }
        super.onDestroy()
    }

    companion object {
        const val PREF_PAUSE_MEDIA = "whisper_pause_media"
        private const val CHANNEL = "dictation_audio"
        fun start(context: Context) {
            runCatching { ContextCompat.startForegroundService(context, Intent(context, DictationAudioService::class.java)) }
                .onFailure {
                    Log.w("DictationAudio", "Could not start audio focus service", it)
                    Toast.makeText(context, "Background media could not be paused", Toast.LENGTH_SHORT).show()
                }
        }
        fun stop(context: Context) { context.stopService(Intent(context, DictationAudioService::class.java)) }
    }
}
