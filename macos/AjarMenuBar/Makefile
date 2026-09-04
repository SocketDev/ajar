.PHONY: help generate build run open clean check-tools

SCHEME      := AjarMenuBar
CONFIG      := Debug
DESTINATION := platform=macOS

help:
	@echo "Targets:"
	@echo "  make generate   regenerate AjarMenuBar.xcodeproj from project.yml"
	@echo "  make build      build the app (Debug)"
	@echo "  make run        build and launch the app"
	@echo "  make open       open the .xcodeproj in Xcode"
	@echo "  make clean      remove build artifacts"

check-tools:
	@command -v xcodegen >/dev/null 2>&1 || { \
	  echo "xcodegen not found. Install with: brew install xcodegen"; \
	  exit 1; \
	}

generate: check-tools
	xcodegen generate

# Always regenerate the project before building so project.yml changes and
# newly-added Swift files in AjarMenuBar/ are picked up. xcodegen is sub-second
# so the cost is negligible.
build: generate
	xcodebuild -scheme $(SCHEME) -configuration $(CONFIG) \
	           -destination '$(DESTINATION)' build

# `run` rebuilds, kills any running instance, then launches the rebuilt app.
# The 1-second sleep between pkill and open lets LaunchServices see the
# previous instance fully exit (avoids `open` returning error -600).
#
# NOTE: do NOT put `#` shell comments inside the recipe below. Make treats
# them as Makefile comments and silently breaks the `; \` line continuation.
run: build
	@APP_PATH="$$(xcodebuild -scheme $(SCHEME) -configuration $(CONFIG) \
	    -showBuildSettings 2>/dev/null \
	    | awk '/ BUILT_PRODUCTS_DIR =/ {print $$3; exit}')/$(SCHEME).app"; \
	if [ ! -d "$$APP_PATH" ]; then \
	  echo "Build artifact not found at $$APP_PATH"; exit 1; \
	fi; \
	pkill -f $(SCHEME) 2>/dev/null || true; \
	sleep 1; \
	open "$$APP_PATH"

open:
	@if [ ! -d AjarMenuBar.xcodeproj ]; then $(MAKE) generate; fi
	xed AjarMenuBar.xcodeproj 2>/dev/null || open AjarMenuBar.xcodeproj

clean:
	rm -rf build
	xcodebuild -scheme $(SCHEME) -configuration $(CONFIG) \
	           -destination '$(DESTINATION)' clean 2>/dev/null || true
