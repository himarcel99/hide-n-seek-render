import Capacitor
import AVFoundation

class HideNSeekViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        super.capacitorDidLoad()

        bridge?.registerPluginType(HideNSeekDisplayPlugin.self)
        configureAudioSession()
    }

    private func configureAudioSession() {
        do {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.playback, mode: .default)
            try audioSession.setActive(true)
        } catch {
            NSLog("HideNSeekViewController audio session configuration failed: %@", error.localizedDescription)
        }
    }
}
