FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /netspeak .

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /netspeak /netspeak
ENV NETSPEAK_DATA=/data
VOLUME /data
EXPOSE 443
ENTRYPOINT ["/netspeak"]
