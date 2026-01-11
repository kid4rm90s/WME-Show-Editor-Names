// ==UserScript==
// @name         WME Show Editor Names
// @namespace    https://greasyfork.org/users/1087400
// @version      2026.01.11.03
// @description  Display usernames below visible editor icons on the map in Waze Map Editor (WME). Includes settings in sidebar
// @author       kid4rm90s
// @include      /^https:\/\/(www|beta)\.waze\.com\/(?!user\/)(.{2,6}\/)?editor\/?.*$/
// @icon         https://www.google.com/s2/favicons?sz=64&domain=waze.com
// @grant        GM_xmlhttpRequest
// @grant        GM_info
// @grant        unsafeWindow
// @license      MIT
// @run-at       document-end
// @connect      greasyfork.org
// @require      https://greasyfork.org/scripts/560385/code/WazeToastr.js
// @downloadURL https://update.greasyfork.org/scripts/562181/WME%20Show%20Editor%20Names.user.js
// @updateURL https://update.greasyfork.org/scripts/562181/WME%20Show%20Editor%20Names.meta.js

// ==/UserScript==

/* global W */
/* global getWmeSdk */

(function() {
    'use strict';
    const updateMessage = `<strong>Version 2026.01.11.03:</strong><br>
    - Fixed bugs that prevent display of editor names<br>`;
    const scriptName = GM_info.script.name;
    const scriptVersion = GM_info.script.version;
    const downloadUrl = GM_info.script.downloadURL;
    const forumURL = 'https://greasyfork.org/scripts/562181-wme-show-editor-names/feedback';
    let wmeSDK;
    let editorLabels = {};
    let updateInterval;
    let missingUsers = new Set(); // Cache for users not found in W.model.users
    let tooltipCache = {}; // Cache for usernames extracted from tooltips
    let pendingTooltips = new Map(); // Track userId -> {markerElement, position} associations
    let tooltipQueue = []; // Queue for tooltip requests
    let isProcessingTooltip = false; // Flag to prevent simultaneous tooltip processing
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
                bottom: -30px !important;
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
        
        // Set up tooltip observer to capture username data
        setupTooltipObserver();
        
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

        // Initial update with longer delay to ensure WME has loaded all online editor data
        setTimeout(updateEditorLabels, 3000); // Increased from 1000ms to 3000ms
        
        // Set up periodic updates (every 3 seconds)
        updateInterval = setInterval(updateEditorLabels, 3000);
        
        log('Editor name display setup complete');
    }

    function setupTooltipObserver() {
        // Watch for tooltips to capture username data
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    // Get tooltip element
                    const tooltip = node.nodeName === 'WZ-TOOLTIP-CONTENT' ? node :
                        (node.querySelector?.('wz-tooltip-content') || null);
                    
                    if (!tooltip || pendingTooltips.size === 0) return;
                    
                    // Extract username and level from tooltip
                    const usernameEl = tooltip.querySelector('.editorName--l1rm7, wz-h7');
                    const levelEl = tooltip.querySelector('.editorLevel--ar4FT, wz-caption');
                    
                    if (!usernameEl || !levelEl) return;
                    
                    const username = usernameEl.textContent.trim();
                    const levelText = levelEl.textContent.trim();
                    const levelMatch = levelText.match(/Level\s+(\d+)/i);
                    const level = levelMatch ? parseInt(levelMatch[1]) : 1;
                    
                    // Find which marker triggered this tooltip by proximity
                    const tooltipRect = tooltip.getBoundingClientRect();
                    let closestUserId = null;
                    let closestDistance = Infinity;

                    pendingTooltips.forEach((data, userId) => {
                        const markerEl = data.markerElement;
                        const storedPos = data.position;
                        const markerRect = markerEl.getBoundingClientRect();
                        
                        // Calculate distance using both current position and stored position
                        const currentDistance = Math.sqrt(
                            Math.pow(tooltipRect.left - markerRect.left, 2) +
                            Math.pow(tooltipRect.top - markerRect.top, 2)
                        );
                        
                        // Verify the stored position hasn't changed much (marker still in same place)
                        const positionDrift = Math.sqrt(
                            Math.pow(storedPos.x - markerRect.left, 2) +
                            Math.pow(storedPos.y - markerRect.top, 2)
                        );
                        
                        // Only consider markers that haven't moved (drift < 10px)
                        if (positionDrift < 10 && currentDistance < closestDistance) {
                            closestDistance = currentDistance;
                            closestUserId = userId;
                        }
                    });

                    if (closestUserId) {
                        tooltipCache[closestUserId] = {
                            username: username,
                            level: level,
                            rank: level - 1
                        };
                        log(`📝 Cached from tooltip - User ${closestUserId}: ${username} (L${level})`);
                        pendingTooltips.delete(closestUserId);
                        
                        // Mark tooltip processing as complete
                        isProcessingTooltip = false;
                        
                        // Process next item in queue
                        setTimeout(() => processTooltipQueue(), 100);
                        
                        // Trigger an update to refresh this marker's label
                        setTimeout(() => updateEditorLabels(), 200);
                    }
                });
            });
        });
        
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
        
        log('Tooltip observer started');
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
            cleanupLabels();
            
            // Find all online editor markers in the DOM (excluding saved places)
            const allMarkers = document.querySelectorAll('.onlineEditorMarker--rHUxm, .map-marker[data-id]');
            const editorMarkers = Array.from(allMarkers).filter(marker => {
                // Exclude saved places markers and other non-editor markers
                const classes = marker.className || '';
                if (classes.includes('saved-places') || classes.includes('savedPlace')) {
                    return false;
                }
                // Only include markers with onlineEditorMarker class
                return classes.includes('onlineEditorMarker');
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
            cleanupLabels();
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
                log('⚠️ No userId found on marker');
                return null;
            }

            // Skip if we've already tried and failed to find this user
            if (missingUsers.has(userId)) {
                return null;
            }

            log(`🔍 Looking up user ID: ${userId}`);

            // Try W.controller.users first (preferred API)
            if (W?.controller?.users) {
                try {
                    const user = W.controller.users.getObjectById(parseInt(userId));
                    const userData = normalizeUserData(user, userId);
                    if (userData) {
                        log(`✅ Found user via W.controller.users: ${userData.username} (ID: ${userId}, Level: ${userData.level})`);
                        return userData;
                    }
                } catch (e) {
                    log(`❌ Error from W.controller.users: ${e.message}`);
                }
            }

            // Fallback: W.model.users.objects (direct object access)
            if (W?.model?.users?.objects) {
                const user = W.model.users.objects[userId];
                const userData = normalizeUserData(user, userId);
                if (userData) {
                    log(`✅ Found user via W.model.users.objects: ${userData.username} (ID: ${userId}, Level: ${userData.level})`);
                    return userData;
                }
            }

            // Check if it's the current logged-in user
            if (W?.loginManager?.user && W.loginManager.user.id === parseInt(userId)) {
                const userData = {
                    username: W.loginManager.user.userName,
                    userId: userId,
                    rank: W.loginManager.user.rank,
                    level: W.loginManager.user.rank + 1
                };
                log(`✅ Found current logged-in user: ${userData.username} (ID: ${userId}, Level: ${userData.level})`);
                return userData;
            }

            // Check tooltip cache
            if (tooltipCache[userId]) {
                const cached = tooltipCache[userId];
                log(`✅ Found user in tooltip cache: ${cached.username} (ID: ${userId}, Level: ${cached.level})`);
                return {
                    username: cached.username,
                    userId: userId,
                    rank: cached.rank,
                    level: cached.level
                };
            }

            // If user model not populated yet, defer
            if (W?.model?.users && W.model.users.length < 2) {
                log('W.model.users not populated yet, skipping placeholder creation.');
                return null;
            }

            // Try to trigger tooltip to get username
            if (triggerTooltipForUser(markerElement, userId)) {
                log(`🎯 Triggered tooltip for user ${userId}, will retry on next update`);
                return null;
            }

            // Extract level from SVG image filename as fallback
            const img = markerElement.querySelector('img[src*="/L"]');
            let level = 1;
            if (img?.src) {
                const levelMatch = img.src.match(/\/L(\d+)\.svg/);
                if (levelMatch) {
                    level = parseInt(levelMatch[1]);
                }
            }
            
            // Mark as missing so we don't keep trying API lookups
            missingUsers.add(userId);
            
            // Return placeholder (will be replaced when tooltip succeeds)
            return {
                username: `User ${userId}`,
                userId: userId,
                rank: level - 1,
                level: level,
                isPlaceholder: true
            };

        } catch (error) {
            logError(`Error getting editor info from marker: ${error.message}`);
            console.error(error);
            return null;
        }
    }

    // Process tooltip queue one at a time
    function processTooltipQueue() {
        // Skip if already processing or queue is empty
        if (isProcessingTooltip || tooltipQueue.length === 0) {
            return;
        }
        
        const { markerElement, userId } = tooltipQueue.shift();
        
        // Check if we still need this tooltip (might be cached already)
        if (tooltipCache[userId]) {
            log(`✓ User ${userId} already cached, skipping queue item`);
            // Process next item
            setTimeout(() => processTooltipQueue(), 50);
            return;
        }
        
        isProcessingTooltip = true;
        log(`⚙️ Processing tooltip queue for user ${userId} (${tooltipQueue.length} remaining)`);
        
        try {
            const tooltipTarget = markerElement.querySelector('wz-tooltip-target');
            if (tooltipTarget) {
                // Store marker position for accurate matching
                const markerRect = markerElement.getBoundingClientRect();
                pendingTooltips.set(userId, {
                    markerElement: markerElement,
                    position: { x: markerRect.left, y: markerRect.top }
                });
                
                // Trigger hover
                const mouseEnterEvent = new MouseEvent('mouseenter', {
                    bubbles: true,
                    cancelable: true
                });
                tooltipTarget.dispatchEvent(mouseEnterEvent);
                
                // Close tooltip after extraction
                setTimeout(() => {
                    const mouseLeaveEvent = new MouseEvent('mouseleave', {
                        bubbles: true,
                        cancelable: true
                    });
                    tooltipTarget.dispatchEvent(mouseLeaveEvent);
                    
                    // Timeout handler if tooltip not captured
                    setTimeout(() => {
                        if (pendingTooltips.has(userId)) {
                            pendingTooltips.delete(userId);
                            isProcessingTooltip = false;
                            log(`⏱️ Tooltip timeout for user ${userId}`);
                            // Process next item
                            setTimeout(() => processTooltipQueue(), 50);
                        }
                    }, 400);
                }, 500);
            } else {
                // No tooltip target found, move to next
                isProcessingTooltip = false;
                setTimeout(() => processTooltipQueue(), 50);
            }
        } catch (e) {
            pendingTooltips.delete(userId);
            isProcessingTooltip = false;
            log(`❌ Error processing tooltip queue for user ${userId}: ${e.message}`);
            // Process next item
            setTimeout(() => processTooltipQueue(), 50);
        }
    }

    // Trigger tooltip to extract username (adds to queue)
    function triggerTooltipForUser(markerElement, userId) {
        // Skip if already processing this user or cached
        if (pendingTooltips.has(userId) || tooltipCache[userId]) {
            return false;
        }
        
        // Check if already in queue
        const alreadyQueued = tooltipQueue.some(item => item.userId === userId);
        if (alreadyQueued) {
            return false;
        }
        
        // Add to queue
        tooltipQueue.push({ markerElement, userId });
        log(`➕ Added user ${userId} to tooltip queue (queue size: ${tooltipQueue.length})`);
        
        // Start processing if not already running
        if (!isProcessingTooltip) {
            setTimeout(() => processTooltipQueue(), 100);
        }
        
        return true;
    }

    // Helper: normalize user data from various sources
    function normalizeUserData(user, userId) {
        if (!user || !user.attributes) return null;
        
        const username = user.attributes.userName || user.attributes.username;
        if (!username) return null;
        
        const rank = user.attributes.rank ?? 0;
        return {
            username,
            userId,
            rank,
            level: rank + 1
        };
    }

    function addUsernameLabel(markerElement, editorInfo) {
        try {
            const username = editorInfo.username;
            const level = editorInfo.level || 1;
            const userId = markerElement.dataset.id;
            const isPlaceholder = editorInfo.isPlaceholder || false;
            
            // Only log for real usernames, not placeholders
            if (!isPlaceholder) {
                log(`Adding label for ${username} to marker with ID ${userId}`);
            }
            
            // Ensure marker has position: relative
            if (markerElement.style.position !== 'relative') {
                markerElement.style.position = 'relative';
            }
            
            // Check if label already exists
            let existingLabel = markerElement.querySelector('.wme-editor-name-label');
            const displayText = `${username} (L${level})`;
            if (existingLabel) {
                // Update existing label
                if (existingLabel.textContent !== displayText) {
                    existingLabel.textContent = displayText;
                    // Only log if it's a real username update
                    if (!isPlaceholder) {
                        log(`Updated label: ${displayText}`);
                    }
                }
                // Show or hide based on settings
                if (settings.enabled) {
                    existingLabel.classList.remove('wme-hidden');
                } else {
                    existingLabel.classList.add('wme-hidden');
                }
                return 'updated';
            }

            // Create label element
            const label = document.createElement('div');
            label.className = 'wme-editor-name-label';

            // Set visibility based on current settings, preventing hidden labels on creation
            if (!settings.enabled) {
                label.classList.add('wme-hidden');
            }

            label.textContent = displayText;
            label.setAttribute('data-username', username);
            label.setAttribute('data-level', level);
            label.setAttribute('data-user-id', userId);

            // Append to marker
            markerElement.appendChild(label);
            
            // Only log for real usernames
            if (!isPlaceholder) {
                log(`Created label: ${displayText}`);
            }
            
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

    function cleanupLabels() {
        // Unified cleanup: remove labels that no longer exist or whose markers are gone
        const labels = document.querySelectorAll('.wme-editor-name-label');
        labels.forEach(label => {
            const parentMarker = label.parentElement;
            const userId = label.getAttribute('data-user-id');
            
            // Remove if parent marker is gone or doesn't have data-id
            if (!parentMarker || !document.body.contains(parentMarker) || !parentMarker.dataset?.id) {
                if (userId && editorLabels[userId]) {
                    delete editorLabels[userId];
                }
                label.remove();
            }
        });
        
        // Clean up editorLabels object for labels no longer in DOM
        Object.keys(editorLabels).forEach(userId => {
            const labelInfo = editorLabels[userId];
            if (labelInfo?.label && !document.body.contains(labelInfo.label)) {
                delete editorLabels[userId];
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
      const updateMonitor = new WazeToastr.Alerts.ScriptUpdateMonitor(scriptName, scriptVersion, downloadUrl, GM_xmlhttpRequest);
          updateMonitor.start(2, true); // Check every 2 hours, check immediately

          // Show the update dialog for the current version
          WazeToastr.Interface.ShowScriptUpdate(scriptName, scriptVersion, updateMessage, downloadUrl, forumURL);
        } else {
          setTimeout(scriptupdatemonitor, 250);
        }
      }
      scriptupdatemonitor();
})();
/******Changelog********
 * v1.5.3 - 2024-06-10
    - Fixed name swapping issue for overlapping editor markers
    - Implemented tooltip queue system for sequential processing
    - Improved proximity matching with position drift detection
    - Fixed MouseEvent construction errors in userscript context
    - Code cleanup: removed deprecated API calls and redundant functions
    - Added helper function for user data normalization
    - Consolidated duplicate cleanup logic
    - Properly implemented missingUsers cache to avoid redundant lookups
 */
