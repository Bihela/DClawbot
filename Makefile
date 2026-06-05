CLUSTER_NAME ?= dclawbot

# Detect OS to conditionally apply sudo
UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
	SUDO =
else
	SUDO = sudo
endif

.PHONY: all setup-cluster build-images load-images deploy clean

all: setup-cluster build-images load-images deploy

setup-cluster:
	@echo "Checking if kind cluster '$(CLUSTER_NAME)' already exists..."
	@if ! $(SUDO) kind get clusters | grep -q "^$(CLUSTER_NAME)\$$" ; then \
		echo "Creating kind cluster '$(CLUSTER_NAME)'..." ; \
		$(SUDO) kind create cluster --name $(CLUSTER_NAME) ; \
	else \
		echo "Cluster '$(CLUSTER_NAME)' already exists. Skipping creation." ; \
	fi
	@echo "Ensuring KEDA Helm repo is added..."
	@$(SUDO) helm repo add kedacore https://kedacore.github.io/charts --force-update
	@$(SUDO) helm repo update
	@echo "Installing KEDA operator via Helm..."
	@$(SUDO) helm upgrade --install keda kedacore/keda --namespace keda --create-namespace
	@echo "Waiting 10 seconds for KEDA CRDs to register..."
	@sleep 10

build-images:
	@echo "Building docker images locally..."
	$(SUDO) docker build -t worker:latest worker/
	$(SUDO) docker build -t webhook:latest webhook/

load-images:
	@echo "Loading docker images into kind cluster '$(CLUSTER_NAME)'..."
	$(SUDO) kind load docker-image worker:latest --name $(CLUSTER_NAME)
	$(SUDO) kind load docker-image webhook:latest --name $(CLUSTER_NAME)

deploy:
	@echo "Applying Kubernetes manifests via Kustomize..."
	$(SUDO) kubectl apply -k .

clean:
	@echo "Deleting kind cluster '$(CLUSTER_NAME)'..."
	$(SUDO) kind delete cluster --name $(CLUSTER_NAME)
