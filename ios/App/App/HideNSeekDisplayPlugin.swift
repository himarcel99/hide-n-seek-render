import Foundation
import Capacitor
import UIKit
import AudioToolbox

@objc(HideNSeekDisplayPlugin)
public class HideNSeekDisplayPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HideNSeekDisplayPlugin"
    public let jsName = "HideNSeekDisplay"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setKeepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setDimmed", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startRevealVibration", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopRevealVibration", returnType: CAPPluginReturnPromise)
    ]

    private var revealVibrationTimer: Timer?
    private var revealVibrationStopTime: Date?

    @objc public func setKeepAwake(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false

        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = enabled
            call.resolve([
                "enabled": enabled
            ])
        }
    }

    // The JS app handles the visual dimming overlay; the native method exists so
    // the bridge contract is stable if native-specific behavior is added later.
    @objc public func setDimmed(_ call: CAPPluginCall) {
        call.resolve([
            "enabled": call.getBool("enabled") ?? false
        ])
    }

    @objc public func startRevealVibration(_ call: CAPPluginCall) {
        let durationMs = max(0, call.getInt("durationMs") ?? 0)
        let pulseMs = max(0, call.getInt("pulseMs") ?? 400)
        let pauseMs = max(0, call.getInt("pauseMs") ?? 200)

        DispatchQueue.main.async {
            self.beginRevealVibration(durationMs: durationMs, pulseMs: pulseMs, pauseMs: pauseMs)
            call.resolve([
                "durationMs": durationMs,
                "pulseMs": pulseMs,
                "pauseMs": pauseMs
            ])
        }
    }

    @objc public func stopRevealVibration(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.stopRevealVibrationTimer()
            call.resolve()
        }
    }

    private func beginRevealVibration(durationMs: Int, pulseMs: Int, pauseMs: Int) {
        stopRevealVibrationTimer()

        guard durationMs > 0 else {
            return
        }

        let stopTime = Date().addingTimeInterval(Double(durationMs) / 1000.0)
        let intervalMs = max(250, pulseMs + pauseMs)

        revealVibrationStopTime = stopTime
        triggerSystemVibration()

        guard intervalMs < durationMs else {
            return
        }

        let timer = Timer.scheduledTimer(withTimeInterval: Double(intervalMs) / 1000.0, repeats: true) { [weak self] timer in
            guard let self else {
                timer.invalidate()
                return
            }

            guard let stopTime = self.revealVibrationStopTime, Date() < stopTime else {
                self.stopRevealVibrationTimer()
                return
            }

            self.triggerSystemVibration()
        }

        RunLoop.main.add(timer, forMode: .common)
        revealVibrationTimer = timer
    }

    private func stopRevealVibrationTimer() {
        revealVibrationTimer?.invalidate()
        revealVibrationTimer = nil
        revealVibrationStopTime = nil
    }

    private func triggerSystemVibration() {
        AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
    }
}
