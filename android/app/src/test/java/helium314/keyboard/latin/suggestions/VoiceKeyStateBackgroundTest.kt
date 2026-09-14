package helium314.keyboard.latin.suggestions

import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.widget.ImageButton
import androidx.test.core.app.ApplicationProvider
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertSame

@RunWith(RobolectricTestRunner::class)
class VoiceKeyStateBackgroundTest {
    @Test
    fun `temporary voice state keeps the themed button background`() {
        val button = ImageButton(ApplicationProvider.getApplicationContext())
        val themedBackground = GradientDrawable().apply { cornerRadius = 12f }
        button.background = themedBackground

        VoiceKeyStateBackground.show(button, Color.RED)
        assertEquals(Color.RED, (button.background as ColorDrawable).color)
        VoiceKeyStateBackground.show(button, Color.rgb(255, 136, 0))
        assertEquals(Color.rgb(255, 136, 0), (button.background as ColorDrawable).color)
        VoiceKeyStateBackground.clear(button)

        assertSame(themedBackground, button.background)
    }
}
