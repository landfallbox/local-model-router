!macro customUnInstall
  IfSilent lmrKeepUserData

  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Do you also want to delete Local Model Router user data?$\r$\n$\r$\nThis removes config.json, logs, and local app state from:$\r$\n$APPDATA\Local Model Router" \
    IDNO lmrKeepUserData

  RMDir /r "$APPDATA\Local Model Router"

lmrKeepUserData:
!macroend