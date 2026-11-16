#include <iostream>
#include <string>

int main() {
    std::string expressao;
    std::cin >> expressao;
    int abertos = 0;
    for (char c : expressao) {
        abertos += c == '(' ? 1 : -1;
        if (abertos < 0) {
            std::cout << "NAO\n";
            return 0;
        }
    }
    std::cout << (abertos == 0 ? "SIM\n" : "NAO\n");
}
