import twirlyIcon from "./assets/kachina-twirly-icon.svg";

type TitleBarProps =
  | {
      hostKind: "electron";
      isMaximized: boolean;
      isClosing?: false;
      onMinimize: () => void;
      onToggleMaximize: () => void;
      onClose: () => void;
    }
  | {
      hostKind: "web";
      isMaximized?: false;
      shutdownState: "running" | "stopping" | "stopped";
      onClose: () => void;
    };

export function TitleBar(props: TitleBarProps): JSX.Element {
  const isElectron = props.hostKind === "electron";

  return (
    <header className={`window-titlebar ${props.hostKind}`}>
      <div className="window-titlebar-brand">
        <img src={twirlyIcon} alt="" aria-hidden="true" className="window-titlebar-icon" />
        <div className="window-titlebar-copy">
          <strong>Kachina</strong>
        </div>
      </div>
      <div className="window-titlebar-controls">
        {isElectron && (
          <>
            <button
              type="button"
              className="window-control"
              aria-label="Minimize window"
              onClick={props.onMinimize}
            >
              <span className="window-control-icon minimize" />
            </button>
            <button
              type="button"
              className="window-control"
              aria-label={props.isMaximized ? "Restore window" : "Maximize window"}
              onClick={props.onToggleMaximize}
            >
              <span
                className={`window-control-icon ${
                  props.isMaximized ? "restore" : "maximize"
                }`}
              />
            </button>
          </>
        )}
        <button
          type="button"
          className="window-control close"
          aria-label={
            isElectron
              ? "Close window"
              : props.shutdownState === "stopping"
                ? "Stopping Kachina server"
                : props.shutdownState === "stopped"
                  ? "Close tab"
                  : "Stop Kachina server"
          }
          disabled={!isElectron && props.shutdownState === "stopping"}
          onClick={props.onClose}
        >
          <span className="window-control-icon close" />
        </button>
      </div>
    </header>
  );
}
