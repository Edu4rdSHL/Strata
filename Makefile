EXTENSION_UUID  = strata@edu4rdshl.dev
DAEMON_RELEASE  = strata-daemon/target/release/strata-daemon
SCHEMA_DIR      = $(EXTENSION_UUID)/schemas
INSTALL_DIR     = $(HOME)/.local/share/gnome-shell/extensions/$(EXTENSION_UUID)
DAEMON_INSTALL  = $(HOME)/.local/bin

.PHONY: all daemon schemas install install-daemon pack clean

all: daemon schemas

daemon:
	cargo build --release --manifest-path=strata-daemon/Cargo.toml

schemas:
	glib-compile-schemas $(SCHEMA_DIR)

# Install the daemon binary to ~/.local/bin (must be in PATH).
install-daemon: daemon
	mkdir -p $(DAEMON_INSTALL)
	cp $(DAEMON_RELEASE) $(DAEMON_INSTALL)/strata-daemon
	@echo "Installed daemon to $(DAEMON_INSTALL)/strata-daemon"
	@echo "Make sure $(DAEMON_INSTALL) is in your PATH."

# Install the GNOME Shell extension only (daemon must already be in PATH).
install: schemas
	mkdir -p $(INSTALL_DIR)/schemas $(INSTALL_DIR)/ui
	cp $(EXTENSION_UUID)/schemas/*.gschema.xml $(INSTALL_DIR)/schemas/
	cp $(SCHEMA_DIR)/gschemas.compiled $(INSTALL_DIR)/schemas/
	cp $(EXTENSION_UUID)/*.js $(INSTALL_DIR)/
	cp $(EXTENSION_UUID)/*.css $(INSTALL_DIR)/
	cp $(EXTENSION_UUID)/metadata.json $(INSTALL_DIR)/
	cp $(EXTENSION_UUID)/ui/*.js $(INSTALL_DIR)/ui/
	@echo "Installed to $(INSTALL_DIR)"
	@echo "Run: gnome-extensions enable $(EXTENSION_UUID)"

# Pack the extension (JS only - no binary).
pack: schemas
	gnome-extensions pack $(EXTENSION_UUID) \
		--extra-source=ui \
		--extra-source=light.css \
		--force
	@echo "Packed: $(EXTENSION_UUID).shell-extension.zip"

clean:
	cargo clean --manifest-path=strata-daemon/Cargo.toml
	rm -f $(SCHEMA_DIR)/gschemas.compiled
	rm -f $(EXTENSION_UUID).shell-extension.zip
