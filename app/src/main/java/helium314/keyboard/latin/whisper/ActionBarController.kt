package helium314.keyboard.latin.whisper

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.View
import android.widget.Button
import android.widget.ImageButton
import helium314.keyboard.latin.R

class ActionBarController(
    private val actionBarView: View,
    private val onMicToggle: Runnable,
    @Suppress("UNUSED_PARAMETER") onActionResult: java.util.function.Consumer<String>,
) {
    private val micButton: ImageButton = actionBarView.findViewById(R.id.action_bar_toggle)
    private val extraButtons = listOf<Button>(
        actionBarView.findViewById(R.id.action_btn_translate),
        actionBarView.findViewById(R.id.action_btn_grammar),
        actionBarView.findViewById(R.id.action_btn_mail_fr),
        actionBarView.findViewById(R.id.action_btn_mail_en),
    )
    private var pulseAnimator: ObjectAnimator? = null

    fun init(@Suppress("UNUSED_PARAMETER") selectedTextProvider: java.util.function.Supplier<String?>) {
        extraButtons.forEach { it.visibility = View.GONE }
        micButton.setOnClickListener { onMicToggle.run() }
    }

    fun updateRecordingState(state: WhisperManager.RecordingState) {
        when (state) {
            WhisperManager.RecordingState.RECORDING -> { setMicColor(Color.parseColor("#CC0000")); startPulse() }
            WhisperManager.RecordingState.TRANSCRIBING -> { stopPulse(); setMicColor(Color.parseColor("#FF8800")) }
            WhisperManager.RecordingState.IDLE -> { stopPulse(); setMicColor(Color.TRANSPARENT); micButton.alpha = 1f }
        }
    }

    private fun setMicColor(color: Int) {
        micButton.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(color) }
    }

    private fun startPulse() {
        stopPulse()
        pulseAnimator = ObjectAnimator.ofFloat(micButton, "alpha", 1f, 0.4f).apply {
            duration = 600; repeatMode = ValueAnimator.REVERSE; repeatCount = ValueAnimator.INFINITE; start()
        }
    }

    private fun stopPulse() { pulseAnimator?.cancel(); pulseAnimator = null }
}
