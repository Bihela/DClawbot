CLUSTER_NAME ?= dclawbot

.PHONY: all setup-cluster build-images load-images deploy clean

all: setup-cluster build-images load-images deploy

setup-cluster:
	@echo "Checking if kind cluster '$(CLUSTER_NAME)' already exists..."
	@if ! sudo kind get clusters | grep -q "^$(CLUSTER_NAME)$$" ; then \
		echo "Creating kind cluster '$(CLUSTER_NAME)'..." ; \
		sudo kind create cluster --name $(CLUSTER_NAME) ; \
	else \
		echo "Cluster '$(CLUSTER_NAME)' already exists. Skipping creation." ; \
	fi
	@echo "Ensuring KEDA Helm repo is added..."
	@sudo helm repo add kedacore https://kedacore.github.io/charts --force-update
	@sudo helm repo update
	@echo "Installing KEDA operator via Helm..."
	@sudo helm upgrade --install keda kedacore/keda --namespace keda --create-namespace

build-images:
	@echo "Building docker images locally..."
	sudo docker build -t worker:latest worker/
	sudo docker build -t webhook:latest webhook/

load-images:
	@echo "Loading docker images into kind cluster '$(CLUSTER_NAME)'..."
	sudo kind load docker-image worker:latest --name $(CLUSTER_NAME)
	sudo kind load docker-image webhook:latest --name $(CLUSTER_NAME)

deploy:
	@echo "Applying Kubernetes manifests..."
	sudo kubectl apply -f worker/k8s.yaml
	# Assuming your webhook and other infrastructure YAMLs are in these directories. 
	# If they aren't, update this to point to your actual YAML files!
	sudo kubectl apply -f webhook/k8s.yaml 

clean:
	@echo "Deleting kind cluster '$(CLUSTER_NAME)'..."
	sudo kind delete cluster --name $(CLUSTER_NAME)