FROM --platform=$BUILDPLATFORM golang:1.23-alpine AS build
WORKDIR /src
ARG TARGETOS TARGETARCH
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN GOMAXPROCS=2 CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags='-s -w' -o /out/market-collector ./cmd/market-collector

FROM gcr.io/distroless/static-debian12:nonroot
ARG BUILD_ARCH
ARG BUILD_VERSION=0.1.0
LABEL io.hass.type="app" io.hass.arch="${BUILD_ARCH}" io.hass.version="${BUILD_VERSION}"
ENV COLLECTOR_VERSION=${BUILD_VERSION}
COPY --from=build /out/market-collector /market-collector
USER nonroot:nonroot
ENTRYPOINT ["/market-collector"]
