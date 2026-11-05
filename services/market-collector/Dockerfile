FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/market-collector ./cmd/market-collector

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/market-collector /market-collector
USER nonroot:nonroot
ENTRYPOINT ["/market-collector"]
