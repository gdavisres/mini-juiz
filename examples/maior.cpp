#include <iostream>
#include <limits>

int main() {
    int n;
    std::cin >> n;
    long long maior = std::numeric_limits<long long>::min();
    for (int i = 0; i < n; ++i) {
        long long valor;
        std::cin >> valor;
        if (valor > maior) maior = valor;
    }
    std::cout << maior << '\n';
}
