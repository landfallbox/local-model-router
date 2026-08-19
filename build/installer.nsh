!macro customUnInstall
  IfSilent lmrKeepUserData

  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Do you also want to delete Heimdall user data?$\r$\n$\r$\nThis removes config.json, logs, and local app state from:$\r$\n$APPDATA\Heimdall" \
    IDNO lmrKeepUserData

  RMDir /r "$APPDATA\Heimdall"

lmrKeepUserData:
!macroend