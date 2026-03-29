import {
  ChevronUpDownIcon,
  CheckIcon,
} from "@heroicons/react/24/outline";
import { Dialog } from "@base-ui-components/react/dialog";
import { Select } from "@base-ui-components/react/select";
import { Slider } from "@base-ui-components/react/slider";
import { Switch } from "@base-ui-components/react/switch";
import type { Settings } from "../types";
import { PRESETS, RESOLUTION_OPTIONS, CODEC_OPTIONS } from "../types";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings;
  activePreset: string;
  onApplyPreset: (name: string) => void;
  onUpdateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  activePreset,
  onApplyPreset,
  onUpdateSetting,
}: SettingsDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Popup className="settings-panel">
          <div className="settings-header">
            <Dialog.Title className="settings-title">Settings</Dialog.Title>
          </div>

          <div className="settings-group">
            <div className="settings-group-title">Presets</div>
            <div className="preset-btns">
              {Object.keys(PRESETS).map((name) => (
                <button key={name} className={`preset-btn ${activePreset === name ? "active" : ""}`} onClick={() => onApplyPreset(name)}>
                  {name.charAt(0).toUpperCase() + name.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-group">
            <div className="settings-group-title">Video</div>

            <div className="setting-row">
              <span className="setting-label">Resolution</span>
              <Select.Root value={settings.max_size} onValueChange={(val) => onUpdateSetting("max_size", val as number)}>
                <Select.Trigger className="select-trigger">
                  <Select.Value>{RESOLUTION_OPTIONS.find((o) => o.value === settings.max_size)?.label}</Select.Value>
                  <ChevronUpDownIcon className="select-icon" />
                </Select.Trigger>
                <Select.Portal>
                  <Select.Positioner className="select-positioner" sideOffset={4}>
                    <Select.Popup className="select-popup">
                      {RESOLUTION_OPTIONS.map((o) => (
                        <Select.Item key={o.value} value={o.value} className="select-item">
                          <Select.ItemIndicator className="select-item-indicator"><CheckIcon /></Select.ItemIndicator>
                          <Select.ItemText>{o.label}</Select.ItemText>
                        </Select.Item>
                      ))}
                    </Select.Popup>
                  </Select.Positioner>
                </Select.Portal>
              </Select.Root>
            </div>

            <div className="setting-row">
              <span className="setting-label">Max FPS</span>
              <span className="setting-value">{settings.max_fps}</span>
            </div>
            <Slider.Root
              className="slider-root"
              value={settings.max_fps}
              onValueChange={(val) => onUpdateSetting("max_fps", val as number)}
              min={15} max={120} step={5}
            >
              <Slider.Control className="slider-control">
                <Slider.Track className="slider-track">
                  <Slider.Indicator className="slider-indicator" />
                  <Slider.Thumb className="slider-thumb" />
                </Slider.Track>
              </Slider.Control>
            </Slider.Root>

            <div className="setting-row" style={{ marginTop: 12 }}>
              <span className="setting-label">Bitrate</span>
              <span className="setting-value">{(settings.video_bit_rate / 1000000).toFixed(0)} Mbps</span>
            </div>
            <Slider.Root
              className="slider-root"
              value={settings.video_bit_rate}
              onValueChange={(val) => onUpdateSetting("video_bit_rate", val as number)}
              min={1000000} max={32000000} step={1000000}
            >
              <Slider.Control className="slider-control">
                <Slider.Track className="slider-track">
                  <Slider.Indicator className="slider-indicator" />
                  <Slider.Thumb className="slider-thumb" />
                </Slider.Track>
              </Slider.Control>
            </Slider.Root>

            <div className="setting-row" style={{ marginTop: 12 }}>
              <span className="setting-label">Codec</span>
              <Select.Root value={settings.video_codec} onValueChange={(val) => onUpdateSetting("video_codec", val as string)}>
                <Select.Trigger className="select-trigger">
                  <Select.Value>{CODEC_OPTIONS.find((o) => o.value === settings.video_codec)?.label}</Select.Value>
                  <ChevronUpDownIcon className="select-icon" />
                </Select.Trigger>
                <Select.Portal>
                  <Select.Positioner className="select-positioner" sideOffset={4}>
                    <Select.Popup className="select-popup">
                      {CODEC_OPTIONS.map((o) => (
                        <Select.Item key={o.value} value={o.value} className="select-item">
                          <Select.ItemIndicator className="select-item-indicator"><CheckIcon /></Select.ItemIndicator>
                          <Select.ItemText>{o.label}</Select.ItemText>
                        </Select.Item>
                      ))}
                    </Select.Popup>
                  </Select.Positioner>
                </Select.Portal>
              </Select.Root>
            </div>
          </div>

          <div className="settings-group">
            <div className="settings-group-title">Audio</div>
            <div className="setting-row">
              <span className="setting-label">Forward device audio</span>
              <Switch.Root
                className="switch-root"
                checked={settings.audio}
                onCheckedChange={(checked) => onUpdateSetting("audio", checked)}
              >
                <Switch.Thumb className="switch-thumb" />
              </Switch.Root>
            </div>
            <div className="setting-hint">Requires Android 11+</div>
          </div>

          <div className="settings-note">
            <strong>Live settings</strong> -- changes reconnect automatically.
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
