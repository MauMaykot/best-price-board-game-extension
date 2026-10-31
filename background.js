// A busca roda na página do painel, porque o Chrome encerra service workers ociosos e
// uma busca com várias cotações poderia morrer no meio.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
