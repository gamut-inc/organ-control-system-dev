    // organTool_Geometry.js - GEOMETRY with Intelligent Caching
    // 00.19 - dialW 44→70, controlLabel added, control.h=2*stops.h
    // 25.05.2026

autowatch = 1;

function createGeometryModule() {
        var MAX_STOPS_PER_COLUMN = 8; // Local constant for this module
        
        var GEOMETRY = {
            // ================================================================================================
            // CORE DIMENSIONS
            // ================================================================================================
            stops: {
                w: 100,
                h: 20,
                margin: -3
            },

            margin: { 
                get x() {return Math.round(GEOMETRY.stops.w/3*2)},  // 
                y: 10   // 20 / 2 (stops.h / 2)
            },
            
            rows: {
                mainControls: 60, // 3    
                header: 70,             
                controllers: 100,       
                divisions: 170,         
                manualSelector: 340,    
                manuals: 360,           
            },
            
            columns: {
                widthOffset: -1,
                w: function() {
                    return GEOMETRY.stops.w + this.widthOffset; 
                },
                margin: function() {
                    return GEOMETRY.stops.margin;
                }
            },
            
            button: {
                size: 40,  
                fontsize: {
                    small: 8,
                    normal: 10,
                    large: 11,
                    larger: 20,
                    extremelyLarge: 30 
                },
                pos: function(yMargin, rows) { 
                    yMargin = yMargin || 0
                    rows = rows || 0;

                    return{
                        x: GEOMETRY.position.centerX(GEOMETRY.margin.x, GEOMETRY.button.size),
                        y: yMargin + (GEOMETRY.stops.h*rows),
                        w: GEOMETRY.button.size,
                        h: GEOMETRY.button.size,
                    }
                }, 
            },
            label: {
                x: 0, y: 0, get w() {return GEOMETRY.stops.w}, get h() {return GEOMETRY.stops.h}
            },

            // ================================================================================================
            // *** PERFORMANCE CACHE SYSTEM ***
            // ================================================================================================
            _cache: {},
            _calculatedWidths: {},
            _calculatedHeights: {},
            
            // Cache management methods
            clearCache: function() {
                this._cache = {};
                this._calculatedWidths = {};
                this._calculatedHeights = {};
            },
            
            getCachedWidth: function(key, calculator) {
                if (!this._cache[key]) {
                    this._cache[key] = calculator();
                }
                return this._cache[key];
            },

            // ================================================================================================
            // GRID SYSTEM - *** FIXED: Removed circular references ***
            // ================================================================================================
            grid: {
                pos: function(row, col, marginX, marginY) {
                    marginX = marginX || 0;
                    marginY = marginY || 0;
                    return {
                        x: col * (GEOMETRY.columns.w() + marginX),
                        y: row * (GEOMETRY.stops.h + marginY)
                    };
                },
                
                columnsNeeded: function(itemCount, maxPerColumn) {
                    maxPerColumn = maxPerColumn || MAX_STOPS_PER_COLUMN;
                    return Math.ceil(itemCount / maxPerColumn);
                },
                
                // *** FIXED: Self-reference using local variable ***
                multiColumnWidth: function(itemCount, marginX, maxPerColumn) {
                    marginX = marginX || 0;
                    maxPerColumn = maxPerColumn || MAX_STOPS_PER_COLUMN;
                    
                    var cacheKey = "col_width_" + itemCount// + "_" + marginX + "_" + maxPerColumn;
                    var self = GEOMETRY; // Local reference
                    
                    return self.getCachedWidth(cacheKey, function() {
                        var columns = self.grid.columnsNeeded(itemCount, maxPerColumn);
                        if (columns <= 1) {
                            return self.columns.w();
                        }
                        if (marginX < 0) {
                            return columns * self.columns.w() + (columns - 1) * marginX;
                        }
                        return columns * (self.columns.w() + marginX) - marginX;
                    });
                }
            },
            
            // ================================================================================================
            // SINUA-SPECIFIC COMPONENTS
            // ================================================================================================
            sinua: {
                // *** CONTROLLERS MODULE ***
                controllers: {
                    dialW: 70, // wide enough to show name label (70px ≈ 10 chars at fs 9)
                    bpatcher: function(count) {
                        var cacheKey = "ctl_"+ count;
                        var self = GEOMETRY;

                        return self.getCachedWidth(cacheKey, function() {
                            var width = count * self.sinua.controllers.dialW;
                            self._calculatedWidths.controllers = width;
                            return {
                                x: self.margin.x,
                                y: self.rows.controllers,
                                w: width,
                                h: 3 * self.stops.h,
                            };
                        });
                    },

                    // knob fills the remaining 2 rows (y=stops.h … 3*stops.h = 60)
                    // Name label position: { x: index*dialW, y:0, w:dialW, h:stops.h }
                    // (computed inline in createControllerSection to avoid stale-module issues)
                    control: function(index) {
                        var dw = GEOMETRY.sinua.controllers.dialW;
                        return {
                            w: dw,
                            h: GEOMETRY.stops.h * 2,
                            x: index * dw,
                            y: GEOMETRY.stops.h
                        };
                    }
                },
                
                // *** TREMULANTS MODULE ***
                tremulants: {
                    bpatcher: function(count) {
                        var cacheKey = "trem_"+ count;
                        var self = GEOMETRY; // Local reference
                        
                        return self.getCachedWidth(cacheKey, function() {
                            return {
                                x: self.margin.x + (self._calculatedWidths.controllers || 0) - 1, 
                                y: self.rows.controllers,
                                w: count * (self.stops.w - 1),
                                h: 3 * self.stops.h
                            };
                        });
                    },
                    
                    subpatcher: function(index) { 
                        var self = GEOMETRY;
                        return { 
                           x: index * (self.stops.w - 1),
                           y: 0, 
                           w: self.stops.w, 
                           h: 3 * self.stops.h,
                       };
                   },

                   on: { 
                    x: 2, 
                    y: 18,  
                    w: 20, 
                    h: 20 
                },

                speed: { 
                    x: 40, 
                    y: 20,   
                    w: 33, 
                    h: 50   
                }
            },

                // *** DIVISIONS MODULE ***
            divisions: {
                bpatcher: function(divisions) {
                    var cacheKey = "div_bp"// + divisions.map(function(d) { 
                    //    return d.stops ? d.stops.length : 0; 
                    //}).join("_");
                        var self = GEOMETRY; // Local reference
                        
                        return self.getCachedWidth(cacheKey, function() {
                            var totalWidth = 0;
                            divisions.forEach(function(division) {
                                totalWidth += self.sinua.divisions.widthForStops(
                                    division.stops ? division.stops.length : 0
                                    );
                            });
                            return {
                                x: 0,
                                y: self.rows.divisions,
                                w: self.margin.x + totalWidth,
                                h: self.stops.h * MAX_STOPS_PER_COLUMN
                            };
                        });
                    },
                    
                    subpatcher: function(divisions, index) {
                        var cacheKey = "div_sub_" + index;// + "_" + divisions.map(function(d) { 
                       //     return d.stops ? d.stops.length : 0; 
                       // }).join("_");
                        var self = GEOMETRY; // Local reference
                        
                        return self.getCachedWidth(cacheKey, function() {
                            var xPos = self.margin.x;
                            for (var i = 0; i < index; i++) {
                                xPos += self.sinua.divisions.widthForStops(
                                    divisions[i].stops ? divisions[i].stops.length : 0
                                    );
                            }
                            return {
                                x: xPos,
                                y: 0,
                                w: self.sinua.divisions.widthForStops(
                                    divisions[index].stops ? divisions[index].stops.length : 0
                                    ),
                                h: self.stops.h * MAX_STOPS_PER_COLUMN
                            };
                        });
                    },
                    
                    stopArray: {
                        x: 0, 
                        y: 0, 
                    },

                    cancel: {
                        get x() {return GEOMETRY.stops.w - 20}, 
                        y: 1,  
                        w: 18, 
                        h: 18
                    },
                    
                    widthForStops: function(stopCount) {
                        var cacheKey = "col_width_" + stopCount;
                        var self = GEOMETRY; // Local reference
                        
                        return self.getCachedWidth(cacheKey, function() {
                            if (stopCount === 0) return self.columns.w();
                            var columns = self.grid.columnsNeeded(stopCount);
                            return columns === 1 ? self.columns.w() : 
                            self.grid.multiColumnWidth(stopCount, self.columns.margin());
                        });
                    },
                    
                    subpatcherLabel: { x: 2, y: 0, w: 95, h: 20 },
                    subpatcherCancel: { 
                        y: 1, 
                        w: 20, 
                        h: 20, 
                        x: function() { return GEOMETRY.stops.w - 20 - 2; }
                    }
                },
                
                // *** MANUAL SELECTOR MODULE ***
                manualSelector: {
                    bpatcher: function(nrOfManuals) {
                        var cacheKey = "man_sel_"+ nrOfManuals;
                        var self = GEOMETRY; // Local reference
                        
                        return self.getCachedWidth(cacheKey, function() {
                            return {
                                x: 0,
                                y: self.rows.manualSelector,
                                w: nrOfManuals * self.margin.x,
                                h: self.stops.h
                            };
                        });
                    }
                },
                
                // *** MANUALS MODULE ***
                manuals: {
                    defaultLayersPerManual: 4,
                    createLayerButton: {
                        w: function() { return GEOMETRY.button.size * 1.5; },
                        h: function() { return GEOMETRY.button.size * 0.8; },
                        x: function() { return GEOMETRY.position.centerX(GEOMETRY.margin.x, this.w()); },
                            y: function() { return GEOMETRY.stops.h * 6; } // Unterhalb der anderen Buttons
                        },

                        bpatcher: function(layerStopData, divisionStops) {
                            divisionStops = divisionStops || [];
                            var cacheKey = "man";
                            var self = GEOMETRY;

                            return self.getCachedWidth(cacheKey, function() {
                                // Mirror generate_layer_stops.py layout:
                                //   movable cols  +  DIV_GAP_COLS (1)  +  div cols
                                var nMovCols  = self.grid.columnsNeeded(layerStopData.length);
                                var nDivCols  = divisionStops.length > 0
                                                ? self.grid.columnsNeeded(divisionStops.length) : 0;
                                var gapCols   = divisionStops.length > 0 ? 1 : 0;
                                var totalCols = nMovCols + gapCols + nDivCols;
                                var totalW    = self.grid.multiColumnWidth(
                                                    totalCols * MAX_STOPS_PER_COLUMN,
                                                    self.columns.margin());
                                var layerHeight = self.stops.h * MAX_STOPS_PER_COLUMN;

                                return {
                                    x: 0,
                                    y: self.rows.manuals,
                                    w: (self.margin.x * 2) + totalW,
                                    h: layerHeight * self.sinua.manuals.defaultLayersPerManual,
                                };
                            });
                        }
                    },

                // *** LAYERS MODULE ***
                    layers: {
                    divisionSpacing: 20, // abstand von Layer-Stops und Division-Stops TODO - does not work yet 
                    bpatcher: function(layerID, layerStopData, divisionStops) {
                        divisionStops = divisionStops || [];
                        var cacheKey = "layer_"+layerID;
                        var self = GEOMETRY;

                        return self.getCachedWidth(cacheKey, function() {
                            // Mirror generate_layer_stops.py layout:
                            //   movable cols  +  DIV_GAP_COLS (1)  +  div cols
                            var nMovCols  = self.grid.columnsNeeded(layerStopData.length);
                            var nDivCols  = divisionStops.length > 0
                                            ? self.grid.columnsNeeded(divisionStops.length) : 0;
                            var gapCols   = divisionStops.length > 0 ? 1 : 0;
                            var totalCols = nMovCols + gapCols + nDivCols;
                            var totalW    = self.grid.multiColumnWidth(
                                                totalCols * MAX_STOPS_PER_COLUMN,
                                                self.columns.margin());
                            var layerHeight = self.stops.h * MAX_STOPS_PER_COLUMN;

                            return {
                                w: self.margin.x + totalW,
                                h: layerHeight,
                                x: self.margin.x,
                                y: layerHeight * (layerID - 1),
                            };
                        });
                    },
                    
                    stopArray: {
                        x: function() { return GEOMETRY.margin.x; }, 
                        y: 0 
                    },
                    
                    divisionArray: function(layerStopCount) {
                        var cacheKey = "div_array_" + layerStopCount;
                        var self = GEOMETRY;

                        return self.getCachedWidth(cacheKey, function() {
                            var layerColumns = self.grid.columnsNeeded(layerStopCount);
                            var layerWidth = 0;
                            if (layerColumns > 0) {
                                layerWidth = layerColumns * (self.columns.w() + self.columns.margin());
                                layerWidth -= self.columns.margin(); // remove trailing margin
                            }
                            // +8 positive gap so DIV buttons never overlap last stop column
                            return {
                                x: self.margin.x + layerWidth + 8,
                                y: 0
                            };
                        });
                    },
                    
                    height: function() {
                        var cacheKey = "layer_height";
                        var self = GEOMETRY;
                        return self.getCachedWidth(cacheKey, function() {
                            return self.stops.h * MAX_STOPS_PER_COLUMN;
                        });
                    }
                }
            },
            
            // ================================================================================================
            // POSITION UTILITIES
            // ================================================================================================
            position: {
                centerX: function(containerWidth, itemWidth) {
                    return (containerWidth - itemWidth) / 2;
                },
                stackY: function(index, itemHeight, spacing) {
                    spacing = spacing || 0;
                    return index * (itemHeight + spacing);
                }
            },

            // ================================================================================================
            // CACHE MANAGEMENT UTILITIES
            // ================================================================================================
            
            getCacheStats: function() {
                return {
                    cacheEntries: Object.keys(this._cache).length,
                    calculatedWidths: Object.keys(this._calculatedWidths).length,
                    calculatedHeights: Object.keys(this._calculatedHeights).length,
                    totalCacheSize: JSON.stringify(this._cache).length
                };
            },
            
            resetForNewOrgan: function() {
                this.clearCache();
                post("GEOMETRY cache reset for new organ\n");
            },
            
            validateCache: function() {
                var invalidKeys = [];
                var self = this;
                
                Object.keys(this._cache).forEach(function(key) {
                    var value = self._cache[key];
                    if (value === null || value === undefined || 
                        (typeof value === 'object' && Object.keys(value).length === 0)) {
                        invalidKeys.push(key);
                }
            });
                
                if (invalidKeys.length > 0) {
                    post("Found " + invalidKeys.length + " invalid cache entries: " + invalidKeys.join(', ') + "\n");
                }
                
                return invalidKeys.length === 0;
            }
        };

        // ================================================================================================
        // *** FIXED: Removed problematic setInterval ***
        // ================================================================================================
        
        // Public API
        return {
            GEOMETRY: GEOMETRY,
            MAX_STOPS_PER_COLUMN: MAX_STOPS_PER_COLUMN
        };
    }

    // ================================================================================================
    // MODULE REGISTRATION
    // ================================================================================================

    if (typeof global !== 'undefined') {
        global.createGeometryModule = createGeometryModule;
    }

    post("organTool_Geometry.js v00.21 - layer/manual bpatcher width includes div gap column\n");
