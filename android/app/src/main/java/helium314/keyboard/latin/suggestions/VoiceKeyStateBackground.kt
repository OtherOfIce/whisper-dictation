package helium314.keyboard.latin.suggestions

import android.graphics.drawable.Drawable
import android.view.View
import java.util.WeakHashMap

internal object VoiceKeyStateBackground {
    private val originalBackgrounds = WeakHashMap<View, Drawable?>()

    fun show(view: View, color: Int) {
        if (!originalBackgrounds.containsKey(view)) originalBackgrounds[view] = view.background
        view.setBackgroundColor(color)
    }

    fun clear(view: View) {
        if (originalBackgrounds.containsKey(view)) view.background = originalBackgrounds.remove(view)
    }
}
