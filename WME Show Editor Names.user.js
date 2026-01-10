// ==UserScript==
// @name         WME Show Editor Names
// @namespace    https://greasyfork.org/users/1087400
// @version      0.1.1
// @description  Display usernames below visible editor icons on the map using WME SDK
// @author       kid4rm90s
// @include      /^https:\/\/(www|beta)\.waze\.com\/(?!user\/)(.{2,6}\/)?editor\/?.*$/
// @icon         https://www.google.com/s2/favicons?sz=64&domain=waze.com
// @grant        GM_xmlhttpRequest
// @grant        GM_info
// @grant        unsafeWindow
// @license      MIT
// @run-at       document-end
// @connect     raw.githubusercontent.com
// @require      https://greasyfork.org/scripts/560385/code/WazeToastr.js
// @downloadURL https://raw.githubusercontent.com/kid4rm90s/WME-Show-Editor-Names/main/WME%20Show%20Editor%20Names.user.js
// @updateURL https://raw.githubusercontent.com/kid4rm90s/WME-Show-Editor-Names/main/WME%20Show%20Editor%20Names.user.js

// ==/UserScript==

/* global W */
/* global getWmeSdk */

(function() {
    'use strict';
    const updateMessage = `<strong>Version 2.6.6 - 2026-01-09:</strong><br>
    - Test<br>`;
    const scriptName = GM_info.script.name;
    const scriptVersion = GM_info.script.version;
    const downloadUrl = GM_info.script.downloadURL;
    let wmeSDK;
    let editorLabels = {};
    let updateInterval;
    let missingUsers = new Set(); // Cache for users not found in W.model.users
    let debugMode = true; // Set to true to see detailed logs
    let settings = {
        enabled: true // Show usernames by default
    };

    // Load settings from localStorage
    function loadSettings() {
        try {
            const saved = localStorage.getItem('WME_EditorNames_Settings');
            if (saved) {
                settings = { ...settings, ...JSON.parse(saved) };
            }
        } catch (e) {
            logError('Failed to load settings: ' + e.message);
        }
    }

    // Save settings to localStorage
    function saveSettings() {
        try {
            localStorage.setItem('WME_EditorNames_Settings', JSON.stringify(settings));
        } catch (e) {
            logError('Failed to save settings: ' + e.message);
        }
    }

    function log(message) {
        if (debugMode) {
            console.log(`${scriptName}: ${message}`);
        }
    }

    function logError(message) {
        console.error(`${scriptName}: ${message}`);
    }

    function logInfo(message) {
        console.info(`${scriptName}: ${message}`);
    }

    // Inject CSS for editor name labels
    function injectCSS() {
        const style = document.createElement('style');
        style.textContent = `
            .wme-editor-name-label {
                position: absolute !important;
                bottom: -22px !important;
                left: 50% !important;
                transform: translateX(-50%) !important;
                background-color: rgba(0, 0, 0, 0.9) !important;
                color: #ffffff !important;
                padding: 3px 8px !important;
                border-radius: 4px !important;
                font-size: 12px !important;
                font-family: Arial, Helvetica, sans-serif !important;
                font-weight: bold !important;
                white-space: nowrap !important;
                pointer-events: none !important;
                z-index: 99999 !important;
                text-align: center !important;
                text-shadow: 1px 1px 3px rgba(0, 0, 0, 1) !important;
                border: 1px solid rgba(255, 255, 255, 0.3) !important;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.5) !important;
                display: block !important;
                min-width: 50px !important;
            }
            .wme-editor-name-label.wme-hidden {
                display: none !important;
            }
            .onlineEditorMarker--rHUxm,
            .map-marker[data-id] {
                position: relative !important;
            }
            #wme-editor-names-settings {
                padding: 10px;
            }
            #wme-editor-names-settings h3 {
                margin-top: 0;
                margin-bottom: 10px;
            }
            .wme-editor-names-option {
                margin: 10px 0;
            }
        `;
        document.head.appendChild(style);
        log('CSS injected');
    }

    function setupUI() {
        // Register sidebar tab
        if (wmeSDK && wmeSDK.Sidebar) {
            wmeSDK.Sidebar.registerScriptTab().then(({ tabLabel, tabPane }) => {
                tabLabel.innerText = 'Editor Names';
                tabLabel.title = 'Show/Hide editor usernames on map';
                
                // Create settings UI
                tabPane.innerHTML = `
                    <div id="wme-editor-names-settings">
                        <h3>Editor Names Settings</h3>
                        <div class="wme-editor-names-option">
                            <label>
                                <input type="checkbox" id="wme-editor-names-enabled" ${settings.enabled ? 'checked' : ''}>
                                <span>Show editor usernames on map</span>
                            </label>
                        </div>
                        <div class="wme-editor-names-option">
                            <small>Displays the username below each visible editor icon on the map.</small>
                        </div>
                        <div class="wme-editor-names-option">
                            <small>Version: ${scriptVersion}</small>
                        </div>
                    </div>
                `;
                
                // Add event listener for checkbox
                const checkbox = tabPane.querySelector('#wme-editor-names-enabled');
                if (checkbox) {
                    checkbox.addEventListener('change', (e) => {
                        settings.enabled = e.target.checked;
                        saveSettings();
                        toggleEditorNames(settings.enabled);
                        logInfo(`Editor names ${settings.enabled ? 'enabled' : 'disabled'}`);
                    });
                }
                
                log('Sidebar tab registered');
            }).catch(error => {
                logError('Failed to register sidebar tab: ' + error.message);
            });
        }
        
        // Register layer switcher checkbox
        if (wmeSDK && wmeSDK.LayerSwitcher) {
            try {
                wmeSDK.LayerSwitcher.addLayerCheckbox({
                    layerCheckboxName: 'Editor Names',
                    layerCheckboxId: 'wme-editor-names-layer',
                    isCheckedByDefault: settings.enabled
                });
                
                // Listen for layer checkbox toggle
                wmeSDK.Events.on({
                    eventName: 'wme-layer-checkbox-toggled',
                    eventHandler: (e) => {
                        if (e.detail && e.detail.name === 'Editor Names') {
                            settings.enabled = e.detail.checked;
                            saveSettings();
                            toggleEditorNames(settings.enabled);
                            
                            // Update sidebar checkbox if exists
                            const sidebarCheckbox = document.getElementById('wme-editor-names-enabled');
                            if (sidebarCheckbox) {
                                sidebarCheckbox.checked = settings.enabled;
                            }
                        }
                    }
                });
                
                log('Layer switcher checkbox registered');
            } catch (error) {
                logError('Failed to register layer switcher: ' + error.message);
            }
        }
    }

    function toggleEditorNames(enabled) {
        logInfo(`Toggling editor names to: ${enabled}`);
        
        if (enabled) {
            // Force update to create/show labels
            logInfo('Creating/showing editor name labels...');
            updateEditorLabels();
            
            // Then ensure all labels are visible by removing hidden class
            setTimeout(() => {
                const labels = document.querySelectorAll('.wme-editor-name-label');
                logInfo(`Found ${labels.length} labels to show`);
                labels.forEach((label) => {
                    label.classList.remove('wme-hidden');
                });
            }, 100);
        } else {
            // Hide all labels by adding hidden class
            const labels = document.querySelectorAll('.wme-editor-name-label');
            logInfo(`Hiding ${labels.length} labels`);
            labels.forEach(label => {
                label.classList.add('wme-hidden');
            });
        }
    }

    function initScript() {
        log('Initializing...');
        
        // Load settings
        loadSettings();
        
        // Inject CSS first
        injectCSS();
        
        // Make sure W object exists
        if (typeof W === 'undefined') {
            log('W object not found, retrying...');
            setTimeout(initScript, 500);
            return;
        }
        
        // Initialize WME SDK
        try {
            wmeSDK = getWmeSdk({
                scriptId: 'wme-editor-names',
                scriptName: scriptName
            });
            log('WME SDK initialized');
        } catch (error) {
            log(`Error initializing SDK: ${error.message}`);
            // Continue without SDK
        }

        // Wait for WME to be ready
        if (wmeSDK && wmeSDK.Events) {
            wmeSDK.Events.once({ eventName: 'wme-ready' }).then(() => {
                log('WME Ready - Starting editor name display');
                setupUI();
                setupEditorNameDisplay();
            });
        } else {
            // Fallback if SDK not available
            log('SDK not available, retrying initialization...');
            setTimeout(initScript, 2000);
        }
    }

    function setupEditorNameDisplay() {
        log('Setting up editor name display...');
        
        // Add custom layer for editor names
        addEditorNameLayer();
        
        // Update editor labels when map data loads
        if (wmeSDK && wmeSDK.Events) {
            wmeSDK.Events.on({
                eventName: 'wme-map-data-loaded',
                eventHandler: () => {
                    // Clear missing users cache when new data loads
                    missingUsers.clear();
                    log('Map data loaded - clearing missing users cache');
                    updateEditorLabels();
                }
            });

            // Update on map move
            wmeSDK.Events.on({
                eventName: 'wme-map-move-end',
                eventHandler: updateEditorLabels
            });

            // Update on zoom
            wmeSDK.Events.on({
                eventName: 'wme-map-zoom-changed',
                eventHandler: updateEditorLabels
            });
        }

        // Set up MutationObserver to watch for new editor markers
        setupMutationObserver();

        // Initial update with delay to ensure DOM is ready
        setTimeout(updateEditorLabels, 1000);
        
        // Set up periodic updates (every 3 seconds)
        updateInterval = setInterval(updateEditorLabels, 3000);
        
        log('Editor name display setup complete');
    }

    function setupMutationObserver() {
        // Watch for new editor markers being added to the DOM
        const observer = new MutationObserver((mutations) => {
            let shouldUpdate = false;
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === 1) { // Element node
                        // Check if it's an editor marker or contains one
                        if (node.classList && (node.classList.contains('onlineEditorMarker--rHUxm') || node.classList.contains('map-marker'))) {
                            shouldUpdate = true;
                        } else if (node.querySelectorAll) {
                            const markers = node.querySelectorAll('.onlineEditorMarker--rHUxm, .map-marker[data-id]');
                            if (markers.length > 0) {
                                shouldUpdate = true;
                            }
                        }
                    }
                });
            });
            
            if (shouldUpdate) {
                log('New editor markers detected, updating labels');
                updateEditorLabels();
            }
        });

        // Start observing the map container
        const mapContainer = document.getElementById('map');
        if (mapContainer) {
            observer.observe(mapContainer, {
                childList: true,
                subtree: true
            });
            log('MutationObserver started');
        } else {
            log('Map container not found for MutationObserver');
        }
    }

    function addEditorNameLayer() {
        // No need to add a layer - we'll work with DOM elements directly
        log('Setting up editor name display');
    }

    function updateEditorLabels() {
        try {
            // Skip if disabled
            if (!settings.enabled) {
                return;
            }
            
            // Clean up old labels first
            clearOldLabels();
            
            // Find all online editor markers in the DOM (excluding saved places)
            const allMarkers = document.querySelectorAll('.onlineEditorMarker--rHUxm, .map-marker[data-id]');
            const editorMarkers = Array.from(allMarkers).filter(marker => {
                // Exclude saved places markers
                const classes = marker.className || '';
                return !classes.includes('saved-places') && !classes.includes('savedPlace');
            });
            
            log(`Found ${editorMarkers.length} editor markers (${allMarkers.length} total markers)`);

            let labelsAdded = 0;
            let labelsUpdated = 0;
            let labelsFailed = 0;
            
            editorMarkers.forEach(marker => {
                // Get the editor information from W.model.users using data-id
                const editorInfo = getEditorInfoFromMarker(marker);
                
                if (editorInfo && editorInfo.username) {
                    const result = addUsernameLabel(marker, editorInfo);
                    if (result === 'created') {
                        labelsAdded++;
                    } else if (result === 'updated') {
                        labelsUpdated++;
                    }
                } else {
                    labelsFailed++;
                }
            });
            
            // Only log if there were new labels
            if (labelsAdded > 0) {
                logInfo(`Added ${labelsAdded} new editor name labels`);
            }
            log(`Markers: ${editorMarkers.length}, Updated: ${labelsUpdated}, Added: ${labelsAdded}, Failed: ${labelsFailed}`);

            // Clean up labels for markers that no longer exist
            cleanupOrphanedLabels();
        } catch (error) {
            logError(`Error updating editor labels: ${error.message}`);
            console.error(error);
        }
    }

    function getEditorInfoFromMarker(markerElement) {
        try {
            // Get the user ID from the data-id attribute
            const userId = markerElement.dataset.id;
            if (!userId) {
                return null;
            }

            // Skip if we've already tried and failed to find this user
            if (missingUsers.has(userId)) {
                return null;
            }

            // Use W.model.users to get editor information
            // Note: WME SDK doesn't have DataModel.Users, so we use W object
            if (!W || !W.model || !W.model.users) {
                log('W.model.users not available');
                return null;
            }

            // Find the user by ID
            const user = W.model.users.getObjectById(userId);
            if (user && user.attributes) {
                const username = user.attributes.userName || user.attributes.username;
                const rank = user.attributes.rank || 0; // rank is 0-indexed (0=L1, 1=L2, etc.)
                const level = rank + 1; // Convert to level (1-6)
                log(`Found user: ${username} (ID: ${userId}, Level: ${level})`);
                return {
                    username: username,
                    userId: userId,
                    rank: rank,
                    level: level
                };
            } else {
                // Add to cache to prevent repeated lookups
                missingUsers.add(userId);
                log(`User not found in W.model.users for ID: ${userId} (cached)`);
            }

            return null;
        } catch (error) {
            logError(`Error getting editor info from marker: ${error.message}`);
            console.error(error);
            return null;
        }
    }

    function addUsernameLabel(markerElement, editorInfo) {
        try {
            const username = editorInfo.username;
            const level = editorInfo.level || 1;
            const userId = markerElement.dataset.id;
            
            log(`Adding label for ${username} to marker with ID ${userId}`);
            
            // Ensure marker has position: relative
            if (markerElement.style.position !== 'relative') {
                markerElement.style.position = 'relative';
                log(`Set marker position to relative`);
            }
            
            // Check if label already exists
            let existingLabel = markerElement.querySelector('.wme-editor-name-label');
            if (existingLabel) {
                // Update existing label
                if (existingLabel.textContent !== username) {
                    existingLabel.textContent = username;
                }
                // Show or hide based on settings
                if (settings.enabled) {
                    existingLabel.classList.remove('wme-hidden');
                } else {
                    existingLabel.classList.add('wme-hidden');
                }
                log(`Updated existing label for ${username} (L${level})`);
                return 'updated';
            }

            // Create label element (no icon needed - WME already shows the level icon)
            const label = document.createElement('div');
            label.className = 'wme-editor-name-label';
            // Add hidden class if disabled
            if (!settings.enabled) {
                label.classList.add('wme-hidden');
            }
            label.textContent = username;
            label.setAttribute('data-username', username);
            label.setAttribute('data-level', level);
            label.setAttribute('data-user-id', userId);

            // Append to marker
            markerElement.appendChild(label);
            
            log(`Created new label for ${username}, parent classes: ${markerElement.className}`);
            log(`Label computed display: ${window.getComputedStyle(label).display}`);
            log(`Label position: bottom=${window.getComputedStyle(label).bottom}, left=${window.getComputedStyle(label).left}`);
            
            // Store reference
            if (userId) {
                editorLabels[userId] = {
                    label: label,
                    marker: markerElement,
                    username: username,
                    level: level
                };
            }
            return 'created';
        } catch (error) {
            logError(`Error adding username label: ${error.message}`);
            console.error(error);
            return 'error';
        }
    }

    function cleanupOrphanedLabels() {
        // Remove labels whose parent containers no longer exist in DOM
        Object.keys(editorLabels).forEach(username => {
            const labelInfo = editorLabels[username];
            if (labelInfo && labelInfo.label && !document.body.contains(labelInfo.label)) {
                delete editorLabels[username];
            }
        });
    }

    function clearOldLabels() {
        // Remove labels that are no longer needed
        const labels = document.querySelectorAll('.wme-editor-name-label');
        labels.forEach(label => {
            // Check if the parent marker still exists in the DOM
            const parentMarker = label.parentElement;
            if (!parentMarker || !document.body.contains(parentMarker)) {
                const userId = label.getAttribute('data-user-id');
                if (userId && editorLabels[userId]) {
                    delete editorLabels[userId];
                }
                label.remove();
                return;
            }
            
            // Check if the parent marker still has the data-id attribute
            if (!parentMarker.dataset || !parentMarker.dataset.id) {
                const userId = label.getAttribute('data-user-id');
                if (userId && editorLabels[userId]) {
                    delete editorLabels[userId];
                }
                label.remove();
            }
        });
    }

    // Initialize when SDK is available
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow.SDK_INITIALIZED) {
        unsafeWindow.SDK_INITIALIZED.then(initScript);
    } else if (window.SDK_INITIALIZED) {
        window.SDK_INITIALIZED.then(initScript);
    } else {
        // Fallback: wait for SDK initialization
        let initAttempts = 0;
        function bootstrap() {
            if (typeof getWmeSdk !== 'undefined') {
                initScript();
            } else if (initAttempts < 20) {
                initAttempts++;
                setTimeout(bootstrap, 500);
            } else {
                console.error(`${scriptName}: Failed to initialize - SDK not found`);
            }
        }
        bootstrap();
    }

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        if (updateInterval) {
            clearInterval(updateInterval);
        }
    });
      function scriptupdatemonitor() {
        if (WazeToastr?.Ready) {
          // Create and start the ScriptUpdateMonitor
          // For GitHub raw URLs, we need to specify metaUrl explicitly (same as downloadUrl for GitHub)
          const updateMonitor = new WazeToastr.Alerts.ScriptUpdateMonitor(
            scriptName,
            scriptVersion,
            downloadUrl,
            GM_xmlhttpRequest,
            downloadUrl, // metaUrl - for GitHub, use the same URL as it contains the @version tag
            /@version\s+(.+)/i // metaRegExp - extracts version from @version tag
          );
          updateMonitor.start(2, true); // Check every 2 hours, check immediately

          // Show the update dialog for the current version
          WazeToastr.Interface.ShowScriptUpdate(scriptName, scriptVersion, updateMessage, downloadUrl);
        } else {
          setTimeout(scriptupdatemonitor, 250);
        }
      }
      scriptupdatemonitor();
})();
