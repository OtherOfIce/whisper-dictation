package helium314.keyboard.latin.whisper

import android.app.Application
import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.AudioRecord
import androidx.test.core.app.ApplicationProvider
import helium314.keyboard.latin.utils.prefs
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.Mockito.*
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.*

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class)
class MicrophoneInputTest {
    private val application = ApplicationProvider.getApplicationContext<Application>()
    private val recorder = mock(AudioRecord::class.java)

    @Before fun resetPreference() {
        application.prefs().edit().remove(MicrophoneInput.PREF_SECONDARY).commit()
    }

    private fun device(type: Int, address: String): AudioDeviceInfo = mock(AudioDeviceInfo::class.java).also {
        `when`(it.type).thenReturn(type)
        `when`(it.address).thenReturn(address)
    }

    @Test fun normalInputLeavesAndroidRoutingUnchanged() {
        assertNull(MicrophoneInput.configure(application, recorder))
        verifyNoInteractions(recorder)
    }

    @Test fun secondarySelectionIgnoresPrimaryAndExternalInputs() {
        val secondary = device(AudioDeviceInfo.TYPE_BUILTIN_MIC, "back")
        val devices = listOf(device(AudioDeviceInfo.TYPE_USB_HEADSET, "back"),
            device(AudioDeviceInfo.TYPE_BUILTIN_MIC, "bottom"), secondary)
        assertSame(secondary, MicrophoneInput.findSecondary(devices))
        assertNull(MicrophoneInput.findSecondary(devices.dropLast(1)))
    }

    @Test fun selectedSecondaryIsAppliedToTheRecorder() {
        application.prefs().edit().putBoolean(MicrophoneInput.PREF_SECONDARY, true).commit()
        val manager = mock(AudioManager::class.java)
        val context = spy(application)
        doReturn(manager).`when`(context).getSystemService(Context.AUDIO_SERVICE)
        val secondary = device(AudioDeviceInfo.TYPE_BUILTIN_MIC, "back")
        `when`(manager.getDevices(AudioManager.GET_DEVICES_INPUTS)).thenReturn(arrayOf(secondary))
        `when`(recorder.setPreferredDevice(secondary)).thenReturn(true)
        assertSame(secondary, MicrophoneInput.configure(context, recorder))
        verify(recorder).setPreferredDevice(secondary)
    }

    @Test fun unavailableSecondaryDoesNotSilentlyRecordFromPrimary() {
        application.prefs().edit().putBoolean(MicrophoneInput.PREF_SECONDARY, true).commit()
        val manager = mock(AudioManager::class.java)
        val context = spy(application)
        doReturn(manager).`when`(context).getSystemService(Context.AUDIO_SERVICE)
        `when`(manager.getDevices(AudioManager.GET_DEVICES_INPUTS)).thenReturn(emptyArray())
        assertFailsWith<IllegalStateException> { MicrophoneInput.configure(context, recorder) }
        verifyNoInteractions(recorder)
    }

    @Test fun rejectedRoutingDoesNotPretendToSelectSecondary() {
        application.prefs().edit().putBoolean(MicrophoneInput.PREF_SECONDARY, true).commit()
        val manager = mock(AudioManager::class.java)
        val context = spy(application)
        doReturn(manager).`when`(context).getSystemService(Context.AUDIO_SERVICE)
        val secondary = device(AudioDeviceInfo.TYPE_BUILTIN_MIC, "back")
        `when`(manager.getDevices(AudioManager.GET_DEVICES_INPUTS)).thenReturn(arrayOf(secondary))
        assertFailsWith<IllegalStateException> { MicrophoneInput.configure(context, recorder) }
    }
}
