// SPDX-License-Identifier: GPL-3.0-only
package helium314.keyboard.latin.whisper

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.AudioRecord
import android.os.Build
import androidx.annotation.RequiresApi
import helium314.keyboard.latin.utils.prefs

/** Selects a separately exposed back microphone without changing Android's default routing. */
object MicrophoneInput {
    const val PREF_SECONDARY = "whisper_use_secondary_microphone"

    fun secondaryDevice(context: Context): AudioDeviceInfo? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return null
        val manager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return null
        return findSecondary(manager.getDevices(AudioManager.GET_DEVICES_INPUTS).toList())
    }

    @RequiresApi(Build.VERSION_CODES.P)
    internal fun findSecondary(devices: List<AudioDeviceInfo>): AudioDeviceInfo? = devices.firstOrNull {
        it.type == AudioDeviceInfo.TYPE_BUILTIN_MIC && it.address.equals("back", ignoreCase = true)
    }

    fun configure(context: Context, recorder: AudioRecord): AudioDeviceInfo? {
        if (!context.prefs().getBoolean(PREF_SECONDARY, false)) return null
        check(Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) { "Secondary microphone selection requires Android 9 or newer" }
        val device = secondaryDevice(context)
            ?: throw IllegalStateException("The secondary microphone is unavailable. Turn it off in Voice input settings.")
        check(recorder.setPreferredDevice(device)) { "Android could not select the secondary microphone" }
        return device
    }
}
